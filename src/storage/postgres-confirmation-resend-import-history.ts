import { validStaffWorkHistoryManifest } from "../portability/staff-work-history.ts";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validConfirmationResendArchiveHistory, validResendOriginScope } from "../portability/confirmation-resend-history.ts";
import { confirmationResendRef } from "../standalone/confirmation-resend-journal.ts";
import { sameScope } from "../standalone/appointment-change-authority.ts";
import { receiptMatches } from "./postgres-cutover-target.ts";
import type { TargetImportRow } from "./postgres-cutover-target.ts";
import type { ScopedConfirmationResendHistory } from "./postgres-confirmation-resend-carryover.ts";
import type Database from "./generated/Database.ts";

type Db = Kysely<Database> | Transaction<Database>;
export type ConfirmationResendImportBinding = Readonly<{
  archiveId: string; manifestDigest: string; sourceScope: LocationScope; targetScope: LocationScope;
  ownerBinding: string; createdAt: string;
}>;
type Failure = Readonly<{ kind: "resendImportUnavailable" }>;

/** Reads the actual audited import, validates the retained record digest and binds each UUID to its reviewed mapping. */
async function bindings(db: Db, tenantId: string): Promise<ReadonlyMap<string, ConfirmationResendImportBinding>> {
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
    from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(db)).rows[0];
  const result = new Map<string, ConfirmationResendImportBinding>();
  if (!registry) return result;
  const data = registry.source_history;
  if (!receiptMatches(registry, data) || data.targetTenantId !== tenantId || data.locations.length < 1 || data.locations.length > 16) {
    throw new Error("invalid resend import receipt");
  }
  const sources = new Set<string>(), targets = new Set<string>();
  for (const location of data.locations) {
    if (!validResendOriginScope(location.sourceScope) || !validResendOriginScope(location.targetScope) ||
        location.sourceScope.tenantId !== data.sourceTenantId || location.targetScope.tenantId !== tenantId ||
        !validConfirmationResendArchiveHistory(location.confirmationResends)) throw new Error("invalid resend import mapping");
    const source = JSON.stringify(location.sourceScope), target = JSON.stringify(location.targetScope);
    if (sources.has(source) || targets.has(target)) throw new Error("ambiguous resend import mapping");
    sources.add(source); targets.add(target);
    for (const row of location.confirmationResends ?? []) {
      if (result.has(row.requestRef)) throw new Error("ambiguous resend import UUID");
      result.set(row.requestRef, { archiveId: data.archiveId, manifestDigest: data.manifestDigest,
        sourceScope: structuredClone(row.originScope ?? location.sourceScope), targetScope: structuredClone(location.targetScope),
        ownerBinding: row.ownerBinding, createdAt: row.createdAt });
    }
  }
  if (!validStaffWorkHistoryManifest(data)) throw new Error("changed resend import history");
  return result;
}

function matchesImportedRow(row: ScopedConfirmationResendHistory, binding: ConfirmationResendImportBinding): boolean {
  return row.clinicId === binding.targetScope.clinicId && row.locationId === binding.targetScope.locationId &&
    row.submission.ownerBinding === binding.ownerBinding && row.submission.createdAt === binding.createdAt;
}

/** Export within the same repeatable-read snapshot. Imported origins survive later transfers; missing barriers cannot disappear. */
export async function carryConfirmationResendOrigins(db: Db, tenantId: string,
  rows: readonly ScopedConfirmationResendHistory[]): Promise<readonly ScopedConfirmationResendHistory[]> {
  const imported = await bindings(db, tenantId), current = new Map(rows.map(row => [row.submission.requestRef, row]));
  for (const [ref, binding] of imported) {
    const row = current.get(ref);
    if (!row || !matchesImportedRow(row, binding)) throw new Error("lost resend import barrier");
  }
  return rows.map(row => {
    const binding = imported.get(row.submission.requestRef);
    return binding ? { ...row, submission: { ...row.submission, originScope: structuredClone(binding.sourceScope) } } : row;
  });
}

/** Trusted current target owner only. No body-supplied mapping, send or mutation port. */
export class PostgresConfirmationResendImportHistory {
  readonly #db: Db;
  readonly #scope: LocationScope;
  constructor(db: Db, scope: LocationScope) {
    if (!validResendOriginScope(scope)) throw new TypeError("invalid resend import target");
    this.#db = db; this.#scope = Object.freeze({ ...scope });
  }
  matches(scope: LocationScope): boolean { return sameScope(this.#scope, scope); }
  async lookup(requestRef: string, signal: AbortSignal): Promise<Result<ConfirmationResendImportBinding | null, Failure>> {
    if (!confirmationResendRef(requestRef) || !(signal instanceof AbortSignal) || signal.aborted) return err({ kind: "resendImportUnavailable" });
    try {
      const imported = (await bindings(this.#db, this.#scope.tenantId)).get(requestRef);
      if (!imported) return signal.aborted ? err({ kind: "resendImportUnavailable" }) : ok(null);
      if (!sameScope(imported.targetScope, this.#scope)) return err({ kind: "resendImportUnavailable" });
      const row = (await sql<{ clinic_id: string; location_id: string; owner_binding: string; created_at: Date }>`select
        clinic_id, location_id, owner_binding, created_at from confirmation_resend_journal
        where tenant_id = ${this.#scope.tenantId} and request_ref = ${requestRef}::uuid`.execute(this.#db)).rows[0];
      if (!row || row.clinic_id !== this.#scope.clinicId || row.location_id !== this.#scope.locationId ||
          row.owner_binding !== imported.ownerBinding || !(row.created_at instanceof Date) || row.created_at.toISOString() !== imported.createdAt || signal.aborted) {
        return err({ kind: "resendImportUnavailable" });
      }
      return ok(structuredClone(imported));
    } catch { return err({ kind: "resendImportUnavailable" }); }
  }
}
