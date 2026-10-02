import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type Database from "./generated/Database.ts";
import type { LocationScope } from "../core/model.ts";
import { validNotificationArchiveHistory, notificationImportHistory } from "../portability/notification-history.ts";
import type { ClinicNotificationArchiveRow } from "../portability/notification-history.ts";
import { isDeepStrictEqual } from "node:util";

type Connection = Kysely<Database> | Transaction<Database>;
type DatabaseRow = { clinic_id: string; version: number; owners: ClinicNotificationArchiveRow["owners"];
  notification_kind: ClinicNotificationArchiveRow["notificationKind"]; owner: ClinicNotificationArchiveRow["owner"];
  previous_owner: ClinicNotificationArchiveRow["previousOwner"]; changed_by: string | null; changed_at: Date | null };
export type NotificationArchiveRecord = ClinicNotificationArchiveRow & { sourceClinicId: string };

export async function readNotificationCarryover(db: Connection, tenantId: string): Promise<readonly NotificationArchiveRecord[]> {
  const rows = (await sql<DatabaseRow>`select clinic_id, version, owners, notification_kind, owner, previous_owner, changed_by, changed_at
    from clinic_notification_settings where tenant_id = ${tenantId} order by clinic_id, version`.execute(db)).rows;
  const heads = new Map(rows.map(row => [row.clinic_id, row.version]));
  const records = rows.map(row => ({ sourceClinicId: row.clinic_id, version: row.version, isHead: row.version === heads.get(row.clinic_id),
    owners: row.owners, notificationKind: row.notification_kind, owner: row.owner, previousOwner: row.previous_owner,
    changedBy: row.changed_by, changedAt: row.changed_at?.toISOString() ?? null }));
  for (const clinicId of heads.keys()) {
    if (!validNotificationArchiveHistory(records.filter(row => row.sourceClinicId === clinicId).map(({ sourceClinicId: _id, ...row }) => row))) {
      throw new Error("invalid stored notification history");
    }
  }
  return records;
}
export async function writeNotificationCarryover(db: Connection, scope: LocationScope, history: readonly ClinicNotificationArchiveRow[] | undefined,
  actorRef: string, importedAt: string): Promise<void> {
  if (!validNotificationArchiveHistory(history)) throw new Error("invalid notification archive history");
  for (const row of notificationImportHistory(history, actorRef, importedAt)) {
    await sql`insert into clinic_notification_settings (tenant_id, clinic_id, version, owners, notification_kind,
      owner, previous_owner, changed_by, changed_at) values (${scope.tenantId}, ${scope.clinicId}, ${row.version},
      ${JSON.stringify(row.owners)}::jsonb, ${row.notificationKind}, ${row.owner}, ${row.previousOwner}, ${row.changedBy}, ${row.changedAt}::timestamptz)`.execute(db);
  }
}
export async function reconcileNotificationCarryover(db: Connection, scope: LocationScope, history: readonly ClinicNotificationArchiveRow[] | undefined,
  actorRef: string, importedAt: string): Promise<number | undefined> {
  if (!validNotificationArchiveHistory(history)) return undefined;
  let records: readonly NotificationArchiveRecord[];
  try { records = await readNotificationCarryover(db, scope.tenantId); }
  catch { return undefined; }
  const actual = records.filter(row => row.sourceClinicId === scope.clinicId).map(({ sourceClinicId: _id, ...row }) => row);
  const expected = notificationImportHistory(history, actorRef, importedAt).map(row => ({ ...row,
    changedAt: row.changedAt === null ? null : new Date(row.changedAt).toISOString() }));
  return isDeepStrictEqual(actual, expected) ? actual.length : undefined;
}
