import { sameVoiceScope, validVoiceLocationScope, validVoiceProfile, validVoiceScope } from "../core/voice-profile.ts";
import { ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { VoiceClinicScope, VoiceProfile } from "../core/voice-profile.ts";
import type { VoiceProfileDeclaration, VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import { voiceProfileUnready } from "../core/voice-profile-registry.ts";
import type { Result } from "../core/model.ts";
import type { ReadinessFailure } from "../core/readiness.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OpenAIVoiceProfileHost } from "../voice/openai-voice-profile.ts";
import type { OpenAIVoiceProfileConfig } from "../voice/openai-voice-profile.ts";
import type { SpeechAdapterFactory, VoiceRuntimeOptions } from "../voice/call-speech-binding.ts";
import { bindReviewedDeepgramVocabulary } from "../voice/reviewed-deepgram-transcription.ts";
import type { DeepgramStreamingTranscriptionConfig } from "../voice/deepgram-streaming-transcription.ts";
import { OwnerFileClinicVocabulary } from "./owner-file-clinic-vocabulary.ts";
import type { ClinicVocabularyConfig } from "./owner-file-clinic-vocabulary.ts";

type Config = Readonly<{
  vocabulary: ClinicVocabularyConfig;
  speech: Omit<OpenAIVoiceProfileConfig, "customTranscription">;
  deepgram: Omit<DeepgramStreamingTranscriptionConfig, "sessionId" | "keyterms">;
}>;

/** Optional live registry for one approved location. Overlapping requests share
 * one bounded current-source read; subsequent batches capture again. Callers
 * receive independent declarations and cancellation does not abort peers. The
 * bounded map holds factories for the latest proven profiles, never caller
 * audio, patient data or quality evidence manufactured by a save. */
export class ReviewedClinicVoiceProfiles implements VoiceProfileRegistry, SpeechAdapterFactory {
  readonly locationScope: LocationScope;
  readonly #config: Config;
  readonly #hosts = new Map<string, OpenAIVoiceProfileHost>();
  #pending: Promise<Result<VoiceProfileDeclaration, ReadinessFailure>> | undefined;
  constructor(config: Config) {
    if (!validVoiceLocationScope(config.vocabulary.scope)) throw new RangeError("invalid vocabulary location scope");
    this.locationScope = Object.freeze({ ...config.vocabulary.scope });
    this.#config = Object.freeze({ vocabulary: Object.freeze({ ...config.vocabulary, scope: this.locationScope }),
      speech: Object.freeze({ ...config.speech }), deepgram: Object.freeze({ ...config.deepgram }) });
  }
  #unready() {
    this.#hosts.clear();
    return voiceProfileUnready();
  }
  async resolve(scope: VoiceClinicScope, incoming?: AbortSignal): Promise<Result<VoiceProfileDeclaration, ReadinessFailure>> {
    if (!validVoiceScope(scope) || !sameVoiceScope(scope, this.locationScope) || incoming?.aborted) return voiceProfileUnready();
    const pending = this.#pending ?? this.#capture({ ...scope });
    if (!this.#pending) {
      this.#pending = pending;
      void pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; }).catch(() => undefined);
    }
    try {
      const result = await awaitUntilAbort(pending, incoming);
      return result?.ok ? ok(structuredClone(result.value)) : voiceProfileUnready();
    } catch { return voiceProfileUnready(); }
  }
  async #capture(scope: VoiceClinicScope): Promise<Result<VoiceProfileDeclaration, ReadinessFailure>> {
    const signal = AbortSignal.timeout(5_000);
    try {
      const captured = await awaitUntilAbort(OwnerFileClinicVocabulary.capture(this.#config.vocabulary), signal);
      if (!captured?.ok) return this.#unready();
      const factory = await bindReviewedDeepgramVocabulary(captured.value, this.#config.deepgram, signal);
      if (!factory.ok) return this.#unready();
      const host = new OpenAIVoiceProfileHost({ ...this.#config.speech, customTranscription: factory.value });
      const result = await awaitUntilAbort(host.resolve(scope), signal);
      if (!result?.ok || result.value.profiles.length > 256) return this.#unready();
      const current = await awaitUntilAbort(captured.value.current(signal), signal);
      if (!current?.ok || signal.aborted) return this.#unready();
      this.#hosts.clear();
      for (const profile of result.value.profiles) if (profile.ready) this.#hosts.set(profile.configurationHash, host);
      return result;
    } catch { return this.#unready(); }
  }
  create(profile: VoiceProfile, sessionId: string, runtime: VoiceRuntimeOptions) {
    if (!validVoiceProfile(profile, { tenantId: this.locationScope.tenantId, clinicId: this.locationScope.clinicId })) return voiceProfileUnready();
    return this.#hosts.get(profile.configurationHash)?.create(profile, sessionId, runtime) ?? voiceProfileUnready();
  }
}
