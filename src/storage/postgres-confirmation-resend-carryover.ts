import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { LocationScope } from "../core/model.ts";
import { validConfirmationResendArchiveHistory, confirmationResendBarrier } from "../portability/confirmation-resend-history.ts";
import type { ConfirmationResendArchiveRow } from "../portability/confirmation-resend-history.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import type Database from "./generated/Database.ts";

type Db = Kysely<Database> | Transaction<Database>;
type Row = { clinic_id: string; location_id: string; request_ref: string; owner_binding: string;
  status: string; message_ref: string | null; created_at: Date; completed_at: Date | null };
export type ScopedConfirmationResendHistory = Readonly<{
  clinicId: string; locationId: string; submission: ConfirmationResendArchiveRow;
}>;

export async function readConfirmationResendCarryover(db: Db, tenantId: string): Promise<readonly ScopedConfirmationResendHistory[]> {
  const rows = (await sql<Row>`select clinic_id, location_id, request_ref, owner_binding, status,
    message_ref, created_at, completed_at from confirmation_resend_journal
    where tenant_id = ${tenantId} order by request_ref`.execute(db)).rows;
  const submissions: unknown = rows.map(row => ({ requestRef: row.request_ref, ownerBinding: row.owner_binding, status: row.status,
    messageRef: row.message_ref, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null }));
  if (!validConfirmationResendArchiveHistory(submissions) || submissions === undefined) throw new Error("invalid resend history");
  return rows.map((row, index) => ({ clinicId: row.clinic_id, locationId: row.location_id, submission: submissions[index]! }));
}

/** Runs in the configuration import transaction; original UUIDs and owner bindings are never regenerated. */
export async function writeConfirmationResendCarryover(trx: Transaction<Database>, scope: LocationScope,
  rows: readonly ConfirmationResendArchiveRow[] | undefined): Promise<void> {
  if (!validConfirmationResendArchiveHistory(rows)) throw new Error("invalid resend history");
  for (const row of rows ?? []) {
    await sql`insert into confirmation_resend_journal
      (tenant_id, clinic_id, location_id, request_ref, owner_binding, status, message_ref, created_at, completed_at)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.requestRef}::uuid,
        ${row.ownerBinding}, ${row.status}, ${row.messageRef}::uuid, ${row.createdAt}::timestamptz,
        ${row.completedAt}::timestamptz)`.execute(trx);
  }
}

/** Checks the whole tenant, including rows under an unmapped location. Never repairs history. */
export async function reconcileConfirmationResendCarryover(db: Db, data: TenantConfigArchiveData): Promise<boolean> {
  const expected: ScopedConfirmationResendHistory[] = [];
  for (const location of data.locations) {
    if (!validConfirmationResendArchiveHistory(location.confirmationResends)) return false;
    for (const submission of location.confirmationResends ?? []) expected.push({
      clinicId: location.targetScope.clinicId, locationId: location.targetScope.locationId, submission: confirmationResendBarrier(submission) });
  }
  expected.sort((a, b) => a.submission.requestRef.localeCompare(b.submission.requestRef));
  return isDeepStrictEqual(await readConfirmationResendCarryover(db, data.targetTenantId), expected);
}
