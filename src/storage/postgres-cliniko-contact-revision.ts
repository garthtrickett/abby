import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { ClinikoContactRevisionOwner } from "../cliniko/contact-revision.ts";

export type ContactRevision = Readonly<{ version: number; blocked: boolean }>;
export type ContactChangeStatus = Readonly<{ binding: "reviewBound" | "legacyUnlinked"; status: "pending" | "completed";
  completionMethod: "inspected" | "staffReviewed" | null; completedBy: string | null }>;
export type ContactRevisionFailure = Readonly<{ kind: "invalidInput" | "storageFailure" | "contactChanged" }>;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const refPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validContactAccount(tenantId: string, fingerprint: string): boolean {
  return typeof tenantId === "string" && tenantId.length > 0 && tenantId.length <= 256 && fingerprintPattern.test(fingerprint);
}

/** Must precede the clinic publication lock. The same order is used by corrections and scans. */
export async function lockContactAccount(db: Kysely<Database>, tenantId: string, fingerprint: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('abby-contact-revision-v1'), hashtext(${JSON.stringify([tenantId, fingerprint])}))`.execute(db);
}

/** One statement observes the revision and all outstanding changes together. */
export async function readContactRevision(db: Kysely<Database>, tenantId: string, fingerprint: string): Promise<ContactRevision> {
  const result = await sql<ContactRevision>`select
    coalesce((select version from cliniko_contact_revisions
      where tenant_id = ${tenantId} and credential_fingerprint = ${fingerprint}), 0) as version,
    exists(select 1 from cliniko_contact_changes
      where tenant_id = ${tenantId} and credential_fingerprint = ${fingerprint}) as blocked`.execute(db);
  const row = result.rows[0];
  if (!row || !Number.isSafeInteger(row.version) || row.version < 0 || typeof row.blocked !== "boolean") {
    throw new Error("invalid contact revision");
  }
  return row;
}

/** The complete alias set is supplied by trusted account provisioning, never inferred from API keys.
 * No patient, contact value, call, or session is persisted here. */
export class PostgresClinikoContactRevision implements ClinikoContactRevisionOwner {
  readonly #db: Kysely<Database>;
  readonly #tenantId: string;
  readonly #fingerprints: readonly string[];
  constructor(db: Kysely<Database>, tenantId: string, credentialFingerprints: readonly string[]) {
    if (!Array.isArray(credentialFingerprints) || credentialFingerprints.length < 1 || credentialFingerprints.length > 100 ||
        credentialFingerprints.some(fp => !validContactAccount(tenantId, fp)) ||
        new Set(credentialFingerprints).size !== credentialFingerprints.length) throw new TypeError("invalid contact account binding");
    this.#db = db; this.#tenantId = tenantId; this.#fingerprints = Object.freeze([...credentialFingerprints].sort());
  }
  matches(tenantId: string, fingerprint: string): boolean {
    return tenantId === this.#tenantId && this.#fingerprints.includes(fingerprint);
  }
  async read(fingerprint: string): Promise<Result<ContactRevision, ContactRevisionFailure>> {
    if (!this.matches(this.#tenantId, fingerprint)) return err({ kind: "invalidInput" });
    try { return ok(await readContactRevision(this.#db, this.#tenantId, fingerprint)); }
    catch { return err({ kind: "storageFailure" }); }
  }
  async begin(correctionRef?: string): Promise<Result<string, ContactRevisionFailure>> {
    const ref = correctionRef ?? randomUUID();
    if (!refPattern.test(ref)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        for (const fp of this.#fingerprints) await lockContactAccount(trx, this.#tenantId, fp);
        const reserved = await sql`insert into cliniko_contact_change_registry
          (tenant_id, change_ref, fingerprints, binding, status)
          values (${this.#tenantId}, ${ref}::uuid, ${this.#fingerprints}::text[], ${correctionRef ? "reviewBound" : "legacyUnlinked"}, 'pending')
          on conflict (tenant_id, change_ref) do nothing returning change_ref`.execute(trx);
        if (reserved.rows.length !== 1) return err({ kind: "contactChanged" });
        for (const fp of this.#fingerprints) {
          await this.#advance(trx, fp);
          await sql`insert into cliniko_contact_changes (tenant_id, credential_fingerprint, change_ref)
            values (${this.#tenantId}, ${fp}, ${ref}::uuid)`.execute(trx);
        }
        return ok(ref);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  /** Account-bound metadata only; a reference by itself never grants resolution authority. */
  async status(changeRef: string): Promise<Result<ContactChangeStatus | null, ContactRevisionFailure>> {
    if (!refPattern.test(changeRef)) return err({ kind: "invalidInput" });
    try {
      const result = await sql<{ fingerprints: string[]; binding: ContactChangeStatus["binding"]; status: ContactChangeStatus["status"];
        completion_method: ContactChangeStatus["completionMethod"]; completed_by: string | null }>`select fingerprints, binding, status, completion_method, completed_by
          from cliniko_contact_change_registry where tenant_id = ${this.#tenantId} and change_ref = ${changeRef}::uuid`.execute(this.#db);
      const row = result.rows[0];
      if (!row) return ok(null);
      if (JSON.stringify(row.fingerprints) !== JSON.stringify(this.#fingerprints)) return err({ kind: "contactChanged" });
      return ok({ binding: row.binding, status: row.status, completionMethod: row.completion_method, completedBy: row.completed_by });
    } catch { return err({ kind: "storageFailure" }); }
  }
  /** Called only after exact native inspection. No timeout automatically clears an uncertain write. */
  async complete(changeRef: string): Promise<Result<true, ContactRevisionFailure>> {
    return this.#complete(changeRef);
  }
  /** Trusted staff-recovery adapter only, after its current independent authorization and native review checks. */
  async completeReviewed(changeRef: string, actorRef: string): Promise<Result<true, ContactRevisionFailure>> {
    if (typeof actorRef !== "string" || !actorRef.trim() || actorRef.trim() !== actorRef || actorRef.length > 256 || /[\p{Cc}\p{Cf}]/u.test(actorRef)) return err({ kind: "invalidInput" });
    return this.#complete(changeRef, actorRef);
  }
  async #complete(changeRef: string, actorRef?: string): Promise<Result<true, ContactRevisionFailure>> {
    if (!refPattern.test(changeRef)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        for (const fp of this.#fingerprints) await lockContactAccount(trx, this.#tenantId, fp);
        const registry = await sql<{ fingerprints: string[]; binding: string; status: string }>`select fingerprints, binding, status
          from cliniko_contact_change_registry where tenant_id = ${this.#tenantId} and change_ref = ${changeRef}::uuid for update`.execute(trx);
        const registered = registry.rows[0];
        if (!registered || registered.status !== "pending" || JSON.stringify(registered.fingerprints) !== JSON.stringify(this.#fingerprints) ||
            actorRef && registered.binding !== "reviewBound") return err({ kind: "contactChanged" });
        const pending = await sql<{ credential_fingerprint: string }>`select credential_fingerprint
          from cliniko_contact_changes where tenant_id = ${this.#tenantId} and change_ref = ${changeRef}::uuid
          order by credential_fingerprint`.execute(trx);
        if (pending.rows.length !== this.#fingerprints.length ||
            pending.rows.some((row, i) => row.credential_fingerprint !== this.#fingerprints[i])) return err({ kind: "contactChanged" });
        for (const fp of this.#fingerprints) await this.#advance(trx, fp);
        await sql`delete from cliniko_contact_changes where tenant_id = ${this.#tenantId} and change_ref = ${changeRef}::uuid`.execute(trx);
        await sql`update cliniko_contact_change_registry set status = 'completed', completed_at = now(),
          completion_method = ${actorRef ? "staffReviewed" : "inspected"}, completed_by = ${actorRef ?? null}
          where tenant_id = ${this.#tenantId} and change_ref = ${changeRef}::uuid`.execute(trx);
        return ok(true);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async #advance(db: Kysely<Database>, fingerprint: string): Promise<void> {
    // Integer exhaustion is an error that rolls back every alias, never a wrap/reused revision.
    await sql`insert into cliniko_contact_revisions (tenant_id, credential_fingerprint, version)
      values (${this.#tenantId}, ${fingerprint}, 1)
      on conflict (tenant_id, credential_fingerprint) do update set version = cliniko_contact_revisions.version + 1`.execute(db);
  }
}
