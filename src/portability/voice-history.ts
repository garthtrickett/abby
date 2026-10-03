import { VOICE_SETTING_KINDS, defaultVoicePreferences, validVoicePreferences, validVoiceRef,
  validVoiceSettingKind, validVoiceSettingValue } from "../core/voice-profile.ts";
import type { VoicePreferences, VoiceSettingKind } from "../core/voice-profile.ts";
import type { VoiceSettingAuditEntry } from "../core/clinic-voice-setting.ts";

export type ClinicVoiceArchiveRow = Readonly<{
  version: number; isHead: boolean; locale: string | null; voiceId: string | null;
  settingKind: VoiceSettingKind | null; value: string | null; previousValue: string | null;
  changedBy: string | null; changedAt: string | null;
}>;
const fields = ["version", "isHead", "locale", "voiceId", "settingKind", "value", "previousValue", "changedBy", "changedAt"].sort().join(",");
/** Public preferences and their targeted history only; executable profiles are never portable. */
export function validVoiceArchiveHistory(value: unknown): value is readonly ClinicVoiceArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const rows: ClinicVoiceArchiveRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== fields ||
      !Number.isSafeInteger(entry.version) || entry.version < 0 || typeof entry.isHead !== "boolean" ||
      !validVoicePreferences({ version: String(entry.version), locale: entry.locale, voiceId: entry.voiceId })) return false;
    rows.push(entry as ClinicVoiceArchiveRow);
  }
  rows.sort((a, b) => a.version - b.version);
  for (const [index, row] of rows.entries()) {
    if (row.version !== index || row.isHead !== (index === rows.length - 1)) return false;
    if (index === 0) {
      if (row.locale !== null || row.voiceId !== null || row.settingKind !== null || row.value !== null ||
        row.previousValue !== null || row.changedBy !== null || row.changedAt !== null) return false;
    } else {
      if (!validVoiceSettingKind(row.settingKind) || !validVoiceSettingValue(row.settingKind, row.value) ||
        !validVoiceSettingValue(row.settingKind, row.previousValue) || !validVoiceRef(row.changedBy) ||
        typeof row.changedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.changedAt) ||
        !Number.isFinite(Date.parse(row.changedAt))) return false;
      const previous = rows[index - 1]!;
      if (row.previousValue !== previous[row.settingKind] || row.value !== row[row.settingKind] ||
        VOICE_SETTING_KINDS.some(kind => kind !== row.settingKind && row[kind] !== previous[kind])) return false;
    }
  }
  return true;
}
export function voiceArchiveSnapshot(rows: readonly ClinicVoiceArchiveRow[] | undefined): Readonly<{
  settings: VoicePreferences; history: readonly VoiceSettingAuditEntry[];
}> {
  if (!validVoiceArchiveHistory(rows)) throw new Error("invalid voice archive history");
  const head = rows?.find(row => row.isHead);
  return { settings: head ? { version: String(head.version), locale: head.locale, voiceId: head.voiceId } : defaultVoicePreferences(),
    history: (rows ?? []).filter(row => row.version > 0).sort((a, b) => a.version - b.version).map(row => ({
      version: String(row.version), kind: row.settingKind!, value: row.value, previousValue: row.previousValue,
      actorRef: row.changedBy!, changedAt: row.changedAt! })) };
}
/** Preserve source history, then independently clear locale and voice before target readiness review. */
export function voiceImportHistory(rows: readonly ClinicVoiceArchiveRow[] | undefined,
  actorRef: string, importedAt: string): readonly ClinicVoiceArchiveRow[] {
  const snapshot = voiceArchiveSnapshot(rows);
  const imported = structuredClone([...(rows ?? [])]).sort((a, b) => a.version - b.version);
  let settings = snapshot.settings;
  for (const kind of VOICE_SETTING_KINDS) {
    if (settings[kind] === null) continue;
    const previousValue = settings[kind]; settings = { ...settings, [kind]: null, version: String(Number(settings.version) + 1) };
    imported.push({ version: Number(settings.version), isHead: true, locale: settings.locale, voiceId: settings.voiceId,
      settingKind: kind, value: null, previousValue, changedBy: actorRef, changedAt: importedAt });
  }
  const result = imported.map(row => ({ ...row, isHead: row.version === Number(settings.version) }));
  if (!validVoiceArchiveHistory(result)) throw new Error("invalid target voice clears");
  return result;
}
