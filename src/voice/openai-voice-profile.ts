import type { TranscriptionPort } from "./media-turn-controller.ts";
import { VOICE_LOCALES as locales, VOICE_PRESENTATION_VERSION } from "../core/voice-presentation.ts";
import { createHash } from "node:crypto";
import { ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { validVoiceProfile, validVoiceRef, validVoiceScope } from "../core/voice-profile.ts";
import type { VoiceClinicScope, VoiceProfile } from "../core/voice-profile.ts";
import type { ReadinessFailure } from "../core/readiness.ts";
import { voiceProfileUnready } from "../core/voice-profile-registry.ts";
import type { VoiceProfileDeclaration, VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { BoundSpeechAdapters, SpeechAdapterFactory, VoiceRuntimeOptions } from "./call-speech-binding.ts";
import { OpenAISpeechProvider, realtimeSpeechModel } from "./openai-speech-provider.ts";
import type { OpenAISpeechProviderConfig } from "./openai-speech-provider.ts";
import { OpenAIRealtimeTranscription } from "./openai-realtime-transcription.ts";
import type { OpenAIRealtimeTranscriptionConfig } from "./openai-realtime-transcription.ts";
import { FirstChunkFallbackSpeech } from "./first-chunk-fallback-speech.ts";

export type SpeechQualityEvidence = Readonly<{ configurationHash: string; qualityVersion: string }>;
export type OpenAIVoiceProfileConfig = Readonly<{
  apiKey: string;
  mode: "conversation" | "keypadAvailability";
  primaryModel?: string;
  fallbackModel?: string;
  primaryFirstChunkMs?: number;
  runtime?: VoiceRuntimeOptions;
  fetch?: typeof fetch;
  socketFactory?: OpenAIRealtimeTranscriptionConfig["socketFactory"];
  speechSocketFactory?: OpenAISpeechProviderConfig["speechSocketFactory"];
  /** An embedding host may supply a different, explicitly versioned transcription adapter. */
  customTranscription?: Readonly<{ version: string; create: (sessionId: string) => TranscriptionPort }>;
  /** Patient-free evidence must prove this exact physical configuration and operating mode. */
  quality?: (scope: VoiceClinicScope, configurationHash: string) => Result<SpeechQualityEvidence, ReadinessFailure>;
}>;
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, ordered(v)]));
  return value;
}

/** Catalogue and adapter construction use the same physical descriptor; credentials never enter it. */
export class OpenAIVoiceProfileHost implements VoiceProfileRegistry, SpeechAdapterFactory {
  private readonly config: OpenAIVoiceProfileConfig;
  private readonly voices: readonly string[];
  private readonly primary: OpenAISpeechProvider;
  private readonly fallback?: OpenAISpeechProvider;
  private readonly synthesisVersion: string;
  constructor(config: OpenAIVoiceProfileConfig) {
    if (!config || !["conversation", "keypadAvailability"].includes(config.mode)) throw new RangeError("invalid voice profile configuration");
    if (config.customTranscription && (!validVoiceRef(config.customTranscription.version) ||
      config.customTranscription.version === "openai-transcription.v1" || typeof config.customTranscription.create !== "function")) throw new RangeError("invalid custom transcription configuration");
    const primaryModel = config.primaryModel ?? "gpt-4o-mini-tts";
    // Preserve the existing model choice; unknown models advertise no proven pairs.
    this.primary = new OpenAISpeechProvider({ ...config, model: primaryModel });
    this.synthesisVersion = [primaryModel, config.fallbackModel].includes(realtimeSpeechModel)
      ? "openai-bound-speech.v2" : "openai-speech.v1";
    if (config.fallbackModel) {
      this.fallback = new OpenAISpeechProvider({ ...config, model: config.fallbackModel });
      new FirstChunkFallbackSpeech({ primary: { async *stream() {} }, fallback: { async *stream() {} },
        primaryFirstChunkMs: config.primaryFirstChunkMs ?? 1_500 });
      if ((config.runtime?.playbackOptions?.firstChunkDeadlineMs ?? config.runtime?.playbackOptions?.stepDeadlineMs ?? 2_000) <= (config.primaryFirstChunkMs ?? 1_500)) throw new RangeError("speech fallback deadline unavailable");
    } else if (config.primaryFirstChunkMs !== undefined) throw new RangeError("speech fallback model required");
    this.config = { ...config, primaryModel, runtime: structuredClone(config.runtime ?? {}),
      ...(config.customTranscription ? { customTranscription: { ...config.customTranscription } } : {}) };
    this.voices = this.primary.voices.filter(voice => !this.fallback || this.fallback.voices.includes(voice));
  }
  private descriptor(locale: string, voiceId: string, runtime: VoiceRuntimeOptions) {
    return { schemaVersion: 1, mode: this.config.mode, locale, voiceId,
      presentationVersion: VOICE_PRESENTATION_VERSION, transcriptionVersion: this.config.customTranscription?.version ?? "openai-transcription.v1",
      synthesisVersion: this.synthesisVersion, hostVersion: "openai-voice-profile.v1",
      transcription: this.config.customTranscription ? { provider: "host", version: this.config.customTranscription.version }
        : { provider: "openai", model: "gpt-live-transcribe", context: { prompt: "English clinic reception.", languages: ["en"] } },
      speech: { primaryModel: this.config.primaryModel!, fallbackModel: this.config.fallbackModel ?? null,
        primaryFirstChunkMs: this.config.fallbackModel ? this.config.primaryFirstChunkMs ?? 1_500 : null,
        voice: voiceId, responseFormat: "pcm", streamFormat: "audio",
        ...(this.synthesisVersion === "openai-bound-speech.v2" ? { primary: this.primary.descriptor(),
          fallback: this.fallback?.descriptor() ?? null } : {}) }, runtime };
  }
  private hash(locale: string, voiceId: string, runtime: VoiceRuntimeOptions): string {
    return createHash("sha256").update(JSON.stringify(ordered(this.descriptor(locale, voiceId, runtime)))).digest("hex");
  }
  private quality(scope: VoiceClinicScope, hash: string): SpeechQualityEvidence | undefined {
    try {
      const evidence = this.config.quality?.(structuredClone(scope), hash);
      return evidence?.ok && evidence.value.configurationHash === hash && validVoiceRef(evidence.value.qualityVersion)
        ? structuredClone(evidence.value) : undefined;
    } catch { return undefined; }
  }
  async resolve(scope: VoiceClinicScope): Promise<Result<VoiceProfileDeclaration, ReadinessFailure>> {
    if (!validVoiceScope(scope) || !this.voices.length) return voiceProfileUnready();
    const bound = structuredClone(scope);
    return ok({ scope: bound, hostVersion: "openai-voice-profile.v1", locales,
      voices: this.voices.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
      profiles: locales.flatMap(({ id: locale }) => this.voices.map(voiceId => {
        const hash = this.hash(locale, voiceId, this.config.runtime!);
        const evidence = this.quality(bound, hash);
        return { locale, voiceId, ready: !!evidence, configurationHash: hash,
          transcriptionVersion: this.config.customTranscription?.version ?? "openai-transcription.v1", synthesisVersion: this.synthesisVersion,
          presentationVersion: VOICE_PRESENTATION_VERSION, qualityVersion: evidence?.qualityVersion ?? "unproven" };
      })) });
  }
  create(profile: VoiceProfile, sessionId: string, runtime: VoiceRuntimeOptions): Result<BoundSpeechAdapters, ReadinessFailure> {
    if (!profile || !validVoiceProfile(profile, profile.scope) ||
        !locales.some(item => item.id === profile.locale) || !this.voices.includes(profile.voiceId)) return voiceProfileUnready();
    const hash = this.hash(profile.locale, profile.voiceId, runtime);
    const descriptor = this.descriptor(profile.locale, profile.voiceId, runtime);
    const evidence = this.quality(profile.scope, hash);
    if (hash !== profile.configurationHash || !evidence || evidence.qualityVersion !== profile.qualityVersion ||
        profile.hostVersion !== descriptor.hostVersion || profile.presentationVersion !== descriptor.presentationVersion ||
        profile.transcriptionVersion !== descriptor.transcriptionVersion || profile.synthesisVersion !== descriptor.synthesisVersion) return voiceProfileUnready();
    const primary = this.primary.create(profile.voiceId);
    const synthesis = this.fallback ? new FirstChunkFallbackSpeech({ primary,
      fallback: this.fallback.create(profile.voiceId), primaryFirstChunkMs: this.config.primaryFirstChunkMs ?? 1_500 }) : primary;
    const transcription = this.config.customTranscription ? this.config.customTranscription.create(sessionId) : new OpenAIRealtimeTranscription({ apiKey: this.config.apiKey, sessionId,
      model: "gpt-live-transcribe", context: { prompt: "English clinic reception.", languages: ["en"] },
      ...(this.config.socketFactory ? { socketFactory: this.config.socketFactory } : {}) });
    return ok({ profile: structuredClone(profile), synthesis, transcription });
  }
}
