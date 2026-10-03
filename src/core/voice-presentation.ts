import type { VoiceProfile } from "./voice-profile.ts";

/** English dialogue and safety flows are the compiled presentation supported by this release. */
export const VOICE_PRESENTATION_VERSION = "english-reception.v1";
export const VOICE_LOCALES = [{ id: "en-AU", label: "English (Australia)" }, { id: "en-US", label: "English (United States)" }] as const;
export function supportedVoiceLocale(locale: unknown): locale is string { return VOICE_LOCALES.some(item => item.id === locale); }
export function validVoicePresentation(profile: VoiceProfile): boolean {
  return profile.presentationVersion === VOICE_PRESENTATION_VERSION && supportedVoiceLocale(profile.locale);
}
