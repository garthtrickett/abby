import { err, ok } from "./model.ts";
import type { Result } from "./model.ts";
import type { PolicyFailure } from "./host.ts";
import type { ReadinessFailure } from "./readiness.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";
import { validVoiceCatalogue, validVoicePreferences, validVoiceProfile, validVoiceRef, validVoiceScope, validVoiceSettingKind, voiceRecord } from "./voice-profile.ts";
import type { VoiceCatalogue, VoiceClinicScope, VoicePreferences, VoiceProfile, VoiceSettingKind } from "./voice-profile.ts";

type DeclaredProfile = Omit<VoiceProfile, "scope" | "settingsVersion" | "hostVersion"> & Readonly<{ ready: boolean }>;
export type VoiceProfileDeclaration = Readonly<{
  scope: VoiceClinicScope;
  hostVersion: string;
  locales: VoiceCatalogue["locales"];
  voices: VoiceCatalogue["voices"];
  profiles: readonly DeclaredProfile[];
}>;
/** Host code proves the adapter pair, approved presentation and pinned quality configuration together. */
export interface VoiceProfileRegistry {
  resolve(scope: VoiceClinicScope, signal?: AbortSignal): Promise<Result<VoiceProfileDeclaration, ReadinessFailure>>;
}
export const voiceProfileUnready = (): Result<never, ReadinessFailure> => err({ kind: "readinessFailed", missing: ["voiceProfile"] });
export const unprovenVoiceProfileRegistry: VoiceProfileRegistry = { resolve: async () => voiceProfileUnready() };

function publicCatalogue(declaration: VoiceProfileDeclaration): VoiceCatalogue {
  return { scope: declaration.scope, locales: declaration.locales, voices: declaration.voices,
    pairs: declaration.profiles.map(({ locale, voiceId, ready }) => ({ locale, voiceId, ready })) };
}
function validDeclaration(value: unknown, scope: VoiceClinicScope): value is VoiceProfileDeclaration {
  const declaration = voiceRecord(value);
  if (!declaration || Object.keys(declaration).sort().join(",") !== "hostVersion,locales,profiles,scope,voices" ||
      !validVoiceRef(declaration.hostVersion) || !Array.isArray(declaration.profiles) ||
      declaration.profiles.length === 0 || declaration.profiles.length > 256) return false;
  for (const item of declaration.profiles) {
    const row = voiceRecord(item);
    if (!row || Object.keys(row).sort().join(",") !==
        "configurationHash,locale,presentationVersion,qualityVersion,ready,synthesisVersion,transcriptionVersion,voiceId" || typeof row.ready !== "boolean") return false;
    const { ready, ...profile } = row;
    void ready;
    if (!validVoiceProfile({ ...profile, scope: declaration.scope, settingsVersion: "0", hostVersion: declaration.hostVersion }, scope)) return false;
  }
  return validVoiceCatalogue(publicCatalogue(declaration as VoiceProfileDeclaration), scope);
}
async function readDeclaration(registry: VoiceProfileRegistry, scope: VoiceClinicScope,
  timer: TimerPort): Promise<Result<VoiceProfileDeclaration, ReadinessFailure>> {
  if (!validVoiceScope(scope)) return voiceProfileUnready();
  const controller = new AbortController();
  let handle: unknown;
  try {
    const bound = structuredClone(scope);
    const timeout = new Promise<Result<never, ReadinessFailure>>(resolve => {
      handle = timer.schedule(() => { controller.abort(); resolve(voiceProfileUnready()); }, 1_500);
    });
    const result = await Promise.race([Promise.resolve().then(() => registry.resolve(structuredClone(bound), controller.signal)), timeout]);
    return result.ok && validDeclaration(result.value, bound) ? ok(structuredClone(result.value)) : voiceProfileUnready();
  } catch { return voiceProfileUnready(); }
  finally { if (handle !== undefined) timer.cancel(handle); }
}
export async function listVoiceOptions(registry: VoiceProfileRegistry, scope: VoiceClinicScope,
  timer: TimerPort = systemTimer): Promise<Result<VoiceCatalogue, PolicyFailure>> {
  if (!validVoiceScope(scope)) return err({ kind: "invalidValue" });
  const bound = structuredClone(scope);
  const declaration = await readDeclaration(registry, bound, timer);
  return ok(declaration.ok ? publicCatalogue(declaration.value) : { scope: bound, locales: [], voices: [], pairs: [] });
}
/** Clearing is permitted after provider withdrawal. Partial setup grants no call readiness. */
export async function approveVoiceChange(registry: VoiceProfileRegistry, scope: VoiceClinicScope,
  candidate: VoicePreferences, kind: VoiceSettingKind, timer: TimerPort = systemTimer): Promise<Result<true, PolicyFailure>> {
  if (!validVoiceScope(scope) || !validVoicePreferences(candidate) || !validVoiceSettingKind(kind)) return err({ kind: "invalidValue" });
  if (candidate[kind] === null) return ok(true);
  const captured = structuredClone(candidate);
  const declaration = await readDeclaration(registry, scope, timer);
  if (!declaration.ok) return declaration;
  const matching = declaration.value.profiles.filter(profile =>
    (captured.locale === null || profile.locale === captured.locale) && (captured.voiceId === null || profile.voiceId === captured.voiceId));
  return matching.length > 0 && (captured.locale === null || captured.voiceId === null || matching.some(profile => profile.ready))
    ? ok(true) : voiceProfileUnready();
}
/** No host fallback overrides unset preferences; admission needs one complete ready pair. */
export async function captureVoiceProfile(registry: VoiceProfileRegistry, scope: VoiceClinicScope,
  settings: VoicePreferences, timer: TimerPort = systemTimer): Promise<Result<VoiceProfile, ReadinessFailure>> {
  if (!validVoiceScope(scope) || !validVoicePreferences(settings) || settings.locale === null || settings.voiceId === null) return voiceProfileUnready();
  const bound = structuredClone(scope);
  const capturedSettings = structuredClone(settings);
  const declaration = await readDeclaration(registry, bound, timer);
  if (!declaration.ok) return declaration;
  const profile = declaration.value.profiles.find(row => row.locale === capturedSettings.locale && row.voiceId === capturedSettings.voiceId && row.ready);
  if (!profile) return voiceProfileUnready();
  const { ready, ...binding } = profile;
  void ready;
  return ok({ ...binding, scope: bound, settingsVersion: capturedSettings.version, hostVersion: declaration.value.hostVersion });
}
