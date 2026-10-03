import type { LocationScope } from "./model.ts";

export type VoiceClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export const VOICE_SETTING_KINDS = ["locale", "voiceId"] as const;
export type VoiceSettingKind = typeof VOICE_SETTING_KINDS[number];
export type VoicePreferences = Readonly<{ version: string; locale: string | null; voiceId: string | null }>;
export type VoiceProfile = Readonly<{
  scope: VoiceClinicScope;
  settingsVersion: string;
  hostVersion: string;
  locale: string;
  voiceId: string;
  transcriptionVersion: string;
  synthesisVersion: string;
  presentationVersion: string;
  qualityVersion: string;
  /** Pinned speech configuration, including primary/fallback adapters; quality evidence must match it. */
  configurationHash: string;
}>;
export type VoiceChoice = Readonly<{ id: string; label: string }>;
export type VoicePair = Readonly<{ locale: string; voiceId: string; ready: boolean }>;
export type VoiceCatalogue = Readonly<{
  scope: VoiceClinicScope;
  locales: readonly VoiceChoice[];
  voices: readonly VoiceChoice[];
  pairs: readonly VoicePair[];
}>;

export function voiceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function validVoiceRef(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
export function voiceClinicScope(scope: LocationScope | VoiceClinicScope): VoiceClinicScope {
  return { tenantId: scope.tenantId, clinicId: scope.clinicId };
}
export function validVoiceScope(value: unknown): value is VoiceClinicScope {
  const scope = voiceRecord(value);
  return !!scope && Object.keys(scope).sort().join(",") === "clinicId,tenantId" &&
    validVoiceRef(scope.tenantId) && validVoiceRef(scope.clinicId);
}
export function validVoiceLocationScope(value: unknown): value is LocationScope {
  const scope = voiceRecord(value);
  return !!scope && Object.keys(scope).sort().join(",") === "clinicId,locationId,tenantId" &&
    validVoiceRef(scope.tenantId) && validVoiceRef(scope.clinicId) && validVoiceRef(scope.locationId);
}
export function sameVoiceScope(left: VoiceClinicScope, right: VoiceClinicScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId;
}
export function validVoiceVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 2_147_483_647;
}
export function validVoiceCursor(value: unknown): value is number | undefined {
  return value === undefined || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
}
export function validVoiceLocale(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try { return new Intl.Locale(value).baseName === value; } catch { return false; }
}
export function validVoiceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}
export function validVoiceSettingKind(value: unknown): value is VoiceSettingKind {
  return value === "locale" || value === "voiceId";
}
export function validVoiceSettingValue(kind: VoiceSettingKind, value: unknown): value is string | null {
  return value === null || (kind === "locale" ? validVoiceLocale(value) : validVoiceId(value));
}
export function defaultVoicePreferences(): VoicePreferences { return { version: "0", locale: null, voiceId: null }; }
export function validVoicePreferences(value: unknown): value is VoicePreferences {
  const state = voiceRecord(value);
  return !!state && Object.keys(state).sort().join(",") === "locale,version,voiceId" && validVoiceVersion(state.version) &&
    validVoiceSettingValue("locale", state.locale) && validVoiceSettingValue("voiceId", state.voiceId);
}
export function validVoiceProfile(value: unknown, scope: VoiceClinicScope): value is VoiceProfile {
  const profile = voiceRecord(value);
  return validVoiceScope(scope) && !!profile && Object.keys(profile).sort().join(",") ===
    "configurationHash,hostVersion,locale,presentationVersion,qualityVersion,scope,settingsVersion,synthesisVersion,transcriptionVersion,voiceId" &&
    validVoiceScope(profile.scope) && sameVoiceScope(profile.scope, scope) && validVoiceVersion(profile.settingsVersion) &&
    validVoiceLocale(profile.locale) && validVoiceId(profile.voiceId) &&
    [profile.hostVersion, profile.transcriptionVersion, profile.synthesisVersion, profile.presentationVersion, profile.qualityVersion].every(validVoiceRef) &&
    typeof profile.configurationHash === "string" && /^[a-f0-9]{64}$/.test(profile.configurationHash);
}
/** Public settings and the optional captured binding must describe the same clinic revision. */
export function validVoicePolicy(value: unknown, scope: LocationScope): boolean {
  const policy = voiceRecord(value);
  if (!validVoiceLocationScope(scope) || !policy || !validVoiceLocationScope(policy.scope) ||
      !sameVoiceScope(policy.scope, scope) || policy.scope.locationId !== scope.locationId ||
      !validVoicePreferences(policy.voiceSettings)) return false;
  return policy.voiceProfile === undefined || validVoiceProfile(policy.voiceProfile, voiceClinicScope(scope)) &&
    policy.voiceProfile.settingsVersion === policy.voiceSettings.version &&
    policy.voiceProfile.locale === policy.voiceSettings.locale && policy.voiceProfile.voiceId === policy.voiceSettings.voiceId;
}
function validChoices(value: unknown, validId: (id: unknown) => boolean): value is readonly VoiceChoice[] {
  return Array.isArray(value) && value.length <= 64 && new Set(value.map(row => voiceRecord(row)?.id)).size === value.length &&
    value.every(item => {
      const row = voiceRecord(item);
      return !!row && Object.keys(row).sort().join(",") === "id,label" && validId(row.id) && validVoiceRef(row.label);
    });
}
export function validVoiceCatalogue(value: unknown, scope: VoiceClinicScope): value is VoiceCatalogue {
  const catalogue = voiceRecord(value);
  if (!validVoiceScope(scope) || !catalogue || Object.keys(catalogue).sort().join(",") !== "locales,pairs,scope,voices" ||
      !validVoiceScope(catalogue.scope) || !sameVoiceScope(catalogue.scope, scope) ||
      !validChoices(catalogue.locales, validVoiceLocale) || !validChoices(catalogue.voices, validVoiceId) ||
      !Array.isArray(catalogue.pairs) || catalogue.pairs.length > 256) return false;
  const pairs = catalogue.pairs.map(voiceRecord);
  return new Set(pairs.map(pair => JSON.stringify([pair?.locale, pair?.voiceId]))).size === pairs.length && pairs.every(pair =>
    !!pair && Object.keys(pair).sort().join(",") === "locale,ready,voiceId" && typeof pair.ready === "boolean" &&
    (catalogue.locales as readonly VoiceChoice[]).some(locale => locale.id === pair.locale) &&
    (catalogue.voices as readonly VoiceChoice[]).some(voice => voice.id === pair.voiceId)) &&
    (catalogue.locales as readonly VoiceChoice[]).every(locale => pairs.some(pair => pair?.locale === locale.id)) &&
    (catalogue.voices as readonly VoiceChoice[]).every(voice => pairs.some(pair => pair?.voiceId === voice.id));
}

export function sameVoiceProfile(left: VoiceProfile, right: VoiceProfile): boolean {
  return sameVoiceScope(left.scope, right.scope) &&
    ["settingsVersion", "hostVersion", "locale", "voiceId", "transcriptionVersion", "synthesisVersion",
      "presentationVersion", "qualityVersion", "configurationHash"].every(key =>
      left[key as Exclude<keyof VoiceProfile, "scope">] === right[key as Exclude<keyof VoiceProfile, "scope">]);
}
