import { ok } from "../../src/core/model.ts";
import type { CallPolicy, Result } from "../../src/core/model.ts";
import type { PolicyStore } from "../../src/core/host.ts";
import type { VoiceProfileRegistry } from "../../src/core/voice-profile-registry.ts";
import type { SpeechAdapterFactory } from "../../src/voice/call-speech-binding.ts";
import type { SpeechSynthesisPort } from "../../src/voice/streamed-playback-port.ts";
import type { TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { voiceDeclaration, voiceRegistry } from "./voice-settings-contract.ts";

/** Explicit trusted-host speech approval for pre-existing synthetic clinical fixtures only. */
export function approvedSyntheticPolicy(policy: CallPolicy): CallPolicy {
  const scope = { tenantId: policy.scope.tenantId, clinicId: policy.scope.clinicId };
  const declaration = voiceDeclaration(scope), { ready, ...profile } = declaration.profiles[0]!;
  void ready;
  return { ...structuredClone(policy), voiceSettings: { version: "2", locale: profile.locale, voiceId: profile.voiceId },
    voiceProfile: { ...profile, scope, settingsVersion: "2", hostVersion: declaration.hostVersion } };
}
/** The fixture host supplies a public speech snapshot; clinical settings and errors still use the real store. */
export function withApprovedSyntheticVoice<T extends Pick<PolicyStore, "read">>(policy: T): T {
  return new Proxy(policy, { get(target, key) {
    if (key === "read") return async (...args: Parameters<PolicyStore["read"]>) => {
      const loaded = await target.read(...args);
      return loaded.ok ? ok(approvedSyntheticPolicy(loaded.value)) : loaded;
    };
    const value = Reflect.get(target, key) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
type Ports = Readonly<{ synthesis: SpeechSynthesisPort }> & (
  Readonly<{ transcription: TranscriptionPort; transcriptionFactory?: never }> |
  Readonly<{ transcription?: never; transcriptionFactory: (sessionId: string) => TranscriptionPort }>);
/** Never used by a production listener; mock adapters are created only after an approved admission. */
export function syntheticSpeech(ports: Ports): Readonly<{ speech: SpeechAdapterFactory; voiceProfiles: VoiceProfileRegistry & SpeechAdapterFactory }> {
  const host: VoiceProfileRegistry & SpeechAdapterFactory = { ...voiceRegistry(), create(profile, sessionId) {
    const transcription = ports.transcriptionFactory ? ports.transcriptionFactory(sessionId) : ports.transcription;
    return ok({ profile: structuredClone(profile), synthesis: ports.synthesis, transcription });
  } };
  return { speech: host, voiceProfiles: host };
}
