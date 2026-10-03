import { err, ok } from "./model.ts";
import type { CallPolicy, Result } from "./model.ts";
import type { PolicyFailure } from "./host.ts";
import { validVoiceLocationScope, validVoicePreferences, voiceClinicScope } from "./voice-profile.ts";
import type { VoicePreferences } from "./voice-profile.ts";
import { captureVoiceProfile } from "./voice-profile-registry.ts";
import type { VoiceProfileRegistry } from "./voice-profile-registry.ts";

/** Location policy and default factories cannot supply clinic preferences or speech authority. */
export async function captureVoicePolicy(policy: CallPolicy, preferences: VoicePreferences,
  registry: VoiceProfileRegistry): Promise<Result<CallPolicy, PolicyFailure>> {
  if (!validVoiceLocationScope(policy.scope)) return err({ kind: "invalidValue" });
  if (!validVoicePreferences(preferences)) return err({ kind: "storageFailure" });
  const { voiceSettings, voiceProfile, ...rawLocation } = policy;
  void voiceSettings; void voiceProfile;
  let location: Omit<CallPolicy, "voiceSettings" | "voiceProfile">;
  try { location = structuredClone(rawLocation); } catch { return err({ kind: "storageFailure" }); }
  const captured = structuredClone(preferences);
  const profile = await captureVoiceProfile(registry, voiceClinicScope(location.scope), captured);
  return ok({ ...location, voiceSettings: captured, ...(profile.ok ? { voiceProfile: profile.value } : {}) });
}
