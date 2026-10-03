import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { sameVoiceProfile, validVoiceProfile } from "../core/voice-profile.ts";
import type { VoiceProfile } from "../core/voice-profile.ts";
import type { ReadinessFailure } from "../core/readiness.ts";
import type { SpeechSynthesisPort } from "./streamed-playback-port.ts";
import type { StreamedPlaybackOptions } from "./streamed-playback-port.ts";
import type { MediaTurnOptions } from "./media-turn-controller.ts";
import type { TranscriptionPort } from "./media-turn-controller.ts";

export type VoiceRuntimeOptions = Readonly<{ mediaOptions?: MediaTurnOptions; playbackOptions?: StreamedPlaybackOptions }>;
export type BoundSpeechAdapters = Readonly<{ profile: VoiceProfile; synthesis: SpeechSynthesisPort; transcription: TranscriptionPort }>;
/** Trusted host construction validates the physical configuration before opening a provider session. */
export interface SpeechAdapterFactory {
  create(profile: VoiceProfile, sessionId: string, runtime: VoiceRuntimeOptions): Result<BoundSpeechAdapters, ReadinessFailure>;
}
const unready = (): Result<never, ReadinessFailure> => err({ kind: "readinessFailed", missing: ["voiceProfile"] });

/** Owns exactly one admitted profile and its providers. No adapter construction precedes binding. */
export class CallSpeechBinding {
  private readonly factory: SpeechAdapterFactory;
  private readonly sessionId: string;
  private bound: BoundSpeechAdapters | undefined;
  private closed = false;
  private readonly runtime: VoiceRuntimeOptions;
  constructor(factory: SpeechAdapterFactory, sessionId: string, runtime: VoiceRuntimeOptions = {}) {
    this.factory = factory; this.sessionId = sessionId; this.runtime = structuredClone(runtime);
  }
  bind(profile: VoiceProfile): Result<void, ReadinessFailure> {
    if (this.closed || !profile || !validVoiceProfile(profile, profile.scope)) return unready();
    const expected = structuredClone(profile);
    if (this.bound) return sameVoiceProfile(this.bound.profile, expected) ? ok(undefined) : unready();
    try {
      const result = this.factory.create(structuredClone(expected), this.sessionId, structuredClone(this.runtime));
      if (!result.ok) return unready();
      const candidate = result.value;
      if (!validVoiceProfile(candidate.profile, expected.scope) || !sameVoiceProfile(candidate.profile, expected) ||
          typeof candidate.synthesis?.stream !== "function" || typeof candidate.transcription?.accept !== "function" ||
          typeof candidate.transcription?.flush !== "function") {
        try { void Promise.resolve(candidate.transcription?.close?.()).catch(() => {}); } catch {}
        return unready();
      }
      this.bound = { ...candidate, profile: structuredClone(expected) };
      return ok(undefined);
    } catch { return unready(); }
  }
  readonly synthesis: SpeechSynthesisPort = { stream: (text, signal) => this.stream(text, signal) };
  private async *stream(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.closed || !this.bound) throw new Error("speech profile unavailable");
    yield* this.bound.synthesis.stream(text, signal);
  }
  readonly transcription: TranscriptionPort = {
    accept: (frame, generation, signal) => this.closed || !this.bound
      ? Promise.resolve(err({ kind: "transcriptionUnavailable" })) : this.bound.transcription.accept(frame, generation, signal),
    flush: (generation, signal) => this.closed || !this.bound
      ? Promise.resolve(err({ kind: "transcriptionUnavailable" })) : this.bound.transcription.flush(generation, signal),
    cancel: async generation => { await this.bound?.transcription.cancel?.(generation); },
    close: async () => {
      if (this.closed) return;
      this.closed = true;
      await this.bound?.transcription.close?.();
    },
  };
}
