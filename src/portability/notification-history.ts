import { NOTIFICATION_KINDS, defaultNotificationSettings, validNotificationSettings } from "../core/notification-policy.ts";
import type { NotificationAuditEntry, NotificationKind, NotificationOwner, NotificationSettings } from "../core/notification-policy.ts";

export type ClinicNotificationArchiveRow = Readonly<{
  version: number; isHead: boolean; owners: NotificationSettings["owners"];
  notificationKind: NotificationKind | null; owner: NotificationOwner | null; previousOwner: NotificationOwner | null;
  changedBy: string | null; changedAt: string | null;
}>;
const fields = ["version", "isHead", "owners", "notificationKind", "owner", "previousOwner", "changedBy", "changedAt"].sort().join(",");
export function defaultNotificationArchiveHistory(): readonly ClinicNotificationArchiveRow[] {
  return [{ version: 0, isHead: true, owners: defaultNotificationSettings().owners,
    notificationKind: null, owner: null, previousOwner: null, changedBy: null, changedAt: null }];
}
/** Preferences are portable; host bindings, provider payloads and delivery authority are not. */
export function validNotificationArchiveHistory(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const rows: ClinicNotificationArchiveRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== fields ||
      !Number.isSafeInteger(entry.version) || entry.version < 0 || typeof entry.isHead !== "boolean" ||
      !validNotificationSettings({ version: String(entry.version), owners: entry.owners })) return false;
    rows.push(entry as ClinicNotificationArchiveRow);
  }
  rows.sort((a, b) => a.version - b.version);
  for (const [index, row] of rows.entries()) {
    if (row.version !== index || row.isHead !== (index === rows.length - 1)) return false;
    if (index === 0) {
      if (NOTIFICATION_KINDS.some(kind => row.owners[kind] !== null) || row.notificationKind !== null || row.owner !== null ||
        row.previousOwner !== null || row.changedBy !== null || row.changedAt !== null) return false;
    } else {
      if (!NOTIFICATION_KINDS.includes(row.notificationKind!) || ![null, "host", "abby"].includes(row.owner) ||
        typeof row.changedBy !== "string" || !row.changedBy.trim() || row.changedBy.length > 256 || /[\u0000-\u001f\u007f]/.test(row.changedBy) ||
        typeof row.changedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.changedAt) || !Number.isFinite(Date.parse(row.changedAt))) return false;
      const previous = rows[index - 1]!;
      if (row.previousOwner !== previous.owners[row.notificationKind!] || row.owner !== row.owners[row.notificationKind!] ||
        NOTIFICATION_KINDS.some(kind => kind !== row.notificationKind && row.owners[kind] !== previous.owners[kind])) return false;
    }
  }
  return true;
}
export function notificationArchiveSnapshot(rows: readonly ClinicNotificationArchiveRow[] | undefined): Readonly<{
  settings: NotificationSettings; history: readonly NotificationAuditEntry[];
}> {
  if (!validNotificationArchiveHistory(rows)) throw new Error("invalid notification archive history");
  const head = rows?.find(row => row.isHead);
  return { settings: head ? { version: String(head.version), owners: structuredClone(head.owners) } : defaultNotificationSettings(),
    history: (rows ?? []).filter(row => row.version > 0).sort((a, b) => a.version - b.version).map(row => ({
      version: String(row.version), kind: row.notificationKind!, owner: row.owner, previousOwner: row.previousOwner,
      actorRef: row.changedBy!, changedAt: row.changedAt! })) };
}
/** Every configured type receives its own auditable target clear before target readiness review. */
export function notificationImportHistory(rows: readonly ClinicNotificationArchiveRow[] | undefined,
  actorRef: string, importedAt: string): readonly ClinicNotificationArchiveRow[] {
  const snapshot = notificationArchiveSnapshot(rows);
  const imported = structuredClone([...(rows ?? [])]).sort((a, b) => a.version - b.version);
  let owners = snapshot.settings.owners;
  let version = Number(snapshot.settings.version);
  for (const kind of NOTIFICATION_KINDS) {
    if (owners[kind] === null) continue;
    const previousOwner = owners[kind]; owners = { ...owners, [kind]: null }; version += 1;
    imported.push({ version, isHead: true, owners, notificationKind: kind, owner: null, previousOwner, changedBy: actorRef, changedAt: importedAt });
  }
  const result = imported.map(row => ({ ...row, isHead: row.version === version }));
  if (!validNotificationArchiveHistory(result)) throw new Error("invalid target notification clears");
  return result;
}
