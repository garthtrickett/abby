import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validVocabularyTerms } from "../core/clinic-vocabulary.ts";
import { validVoiceLocationScope, voiceClinicScope } from "../core/voice-profile.ts";
import type { VoiceClinicScope } from "../core/voice-profile.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { DeepgramStreamingTranscription } from "./deepgram-streaming-transcription.ts";
import type { DeepgramStreamingTranscriptionConfig } from "./deepgram-streaming-transcription.ts";
import type { MediaFrame, TranscriptionFailure, TranscriptionPort } from "./media-turn-controller.ts";

type Failure = Readonly<{ kind: "unavailable" }>;
export interface ReviewedVocabularyBinding {
  readonly version: string;
  readonly scope: LocationScope;
  current(signal: AbortSignal): Promise<Result<readonly string[], Failure>>;
}
type Factory = Readonly<{ version: string; scope: VoiceClinicScope; create(sessionId: string): TranscriptionPort }>;
const unavailable = (): Result<never, TranscriptionFailure> => err({ kind: "transcriptionUnavailable" });

/** Bind one reviewed snapshot to the existing custom-transcriber seam. Its exact
 * identity enters the physical profile hash, so old quality evidence cannot be
 * inherited by a changed dictionary. This helper never supplies quality evidence. */
export async function bindReviewedDeepgramVocabulary(binding: ReviewedVocabularyBinding,
  config: Omit<DeepgramStreamingTranscriptionConfig, "sessionId" | "keyterms">,
  signal: AbortSignal): Promise<Result<Factory, Failure>> {
  try {
    const fixedConfig = { ...config };
    if (typeof binding.version !== "string" || !/^[a-f0-9]{64}$/.test(binding.version) ||
        !validVoiceLocationScope(binding.scope)) return err({ kind: "unavailable" });
    const captured = await awaitUntilAbort(binding.current(signal), signal);
    if (!captured?.ok || signal.aborted || !validVocabularyTerms(captured.value)) return err({ kind: "unavailable" });
    const terms = Object.freeze([...captured.value]), identity = binding.version;
    // Constructor validation performs no network I/O. Refuse missing/invalid
    // credentials and adapter configuration before advertising a usable factory.
    const checked = new DeepgramStreamingTranscription({ ...fixedConfig, sessionId: "vocabulary-configuration-check", keyterms: terms });
    await checked.close();
    const version = "deepgram-nova3-reviewed.v1:" + createHash("sha256").update(JSON.stringify([identity, terms])).digest("hex");
    return ok({ version, scope: voiceClinicScope(binding.scope), create(sessionId) {
      const port = new DeepgramStreamingTranscription({ ...fixedConfig, sessionId, keyterms: terms });
      let closed = false;
      let cancelledThrough = 0;
      const close = async (): Promise<void> => { closed = true; await port.close(); };
      const current = async (signal: AbortSignal): Promise<boolean> => {
        if (closed || signal.aborted || binding.version !== identity) return false;
        try {
          const found = await awaitUntilAbort(binding.current(signal), signal);
          return !!found?.ok && !signal.aborted && binding.version === identity &&
            validVocabularyTerms(found.value) && JSON.stringify(found.value) === JSON.stringify(terms);
        } catch { return false; }
      };
      const admitted = async (generation: number, signal: AbortSignal): Promise<boolean> => {
        if (generation <= cancelledThrough) return false;
        const valid = await current(signal);
        // Cancellation may happen while the file/directory read is suspended,
        // before the underlying provider has a turn that it could cancel.
        if (generation <= cancelledThrough) return false;
        if (!valid) await close();
        return valid;
      };
      return {
        async accept(frame: MediaFrame, generation: number, signal: AbortSignal) {
          if (!await admitted(generation, signal)) return unavailable();
          const result = await port.accept(frame, generation, signal);
          if (!await admitted(generation, signal)) return unavailable();
          return result;
        },
        async flush(generation: number, signal: AbortSignal) {
          if (!await admitted(generation, signal)) return unavailable();
          const result = await port.flush(generation, signal);
          if (!await admitted(generation, signal)) return unavailable();
          return result;
        },
        async cancel(generation: number) {
          if (Number.isSafeInteger(generation) && generation > 0) cancelledThrough = Math.max(cancelledThrough, generation);
          await port.cancel(generation);
        },
        close,
      };
    } });
  } catch { return err({ kind: "unavailable" }); }
}
