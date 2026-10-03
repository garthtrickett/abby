import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type Database from "./generated/Database.ts";
import type { ClinicVoiceSettingsTenantId } from "./generated/public/ClinicVoiceSettings.ts";
import type { VoiceClinicScope, VoiceSettingKind } from "../core/voice-profile.ts";
import { validVoiceArchiveHistory, voiceImportHistory } from "../portability/voice-history.ts";
import type { ClinicVoiceArchiveRow } from "../portability/voice-history.ts";

type Connection = Kysely<Database> | Transaction<Database>;
export type VoiceArchiveRecord = ClinicVoiceArchiveRow & Readonly<{ sourceClinicId: string }>;
export async function readVoiceCarryover(db: Connection, tenantId: string): Promise<readonly VoiceArchiveRecord[]> {
  const rows = await db.selectFrom("clinic_voice_settings").selectAll()
    .where("tenant_id", "=", tenantId as ClinicVoiceSettingsTenantId).orderBy("clinic_id").orderBy("version").execute();
  const heads = new Map<string, number>(rows.map(row => [row.clinic_id, row.version]));
  const records = rows.map(row => ({ sourceClinicId: row.clinic_id, version: row.version, isHead: row.version === heads.get(row.clinic_id),
    locale: row.locale, voiceId: row.voice_id, settingKind: row.setting_kind as VoiceSettingKind | null,
    value: row.setting_value, previousValue: row.previous_value, changedBy: row.changed_by, changedAt: row.changed_at?.toISOString() ?? null }));
  for (const clinicId of heads.keys()) {
    if (!validVoiceArchiveHistory(records.filter(row => row.sourceClinicId === clinicId).map(({ sourceClinicId: _id, ...row }) => row))) {
      throw new Error("invalid stored voice history");
    }
  }
  return records;
}
export async function writeVoiceCarryover(db: Connection, scope: VoiceClinicScope, history: readonly ClinicVoiceArchiveRow[] | undefined,
  actorRef: string, importedAt: string): Promise<void> {
  for (const row of voiceImportHistory(history, actorRef, importedAt)) {
    await sql`insert into clinic_voice_settings (tenant_id, clinic_id, version, locale, voice_id, setting_kind,
      setting_value, previous_value, changed_by, changed_at) values (${scope.tenantId}, ${scope.clinicId}, ${row.version},
      ${row.locale}, ${row.voiceId}, ${row.settingKind}, ${row.value}, ${row.previousValue}, ${row.changedBy}, ${row.changedAt}::timestamptz)`.execute(db);
  }
}
export async function reconcileVoiceCarryover(db: Connection, scope: VoiceClinicScope, history: readonly ClinicVoiceArchiveRow[] | undefined,
  actorRef: string, importedAt: string): Promise<number | undefined> {
  if (!validVoiceArchiveHistory(history)) return undefined;
  try {
    const records = await readVoiceCarryover(db, scope.tenantId);
    const actual = records.filter(row => row.sourceClinicId === scope.clinicId).map(({ sourceClinicId: _id, ...row }) => row);
    const expected = voiceImportHistory(history, actorRef, importedAt).map(row => ({ ...row,
      changedAt: row.changedAt === null ? null : new Date(row.changedAt).toISOString() }));
    return isDeepStrictEqual(actual, expected) ? actual.length : undefined;
  } catch { return undefined; }
}
