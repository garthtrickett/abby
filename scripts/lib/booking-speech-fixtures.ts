import { execFileSync } from "node:child_process";
import type { SpeechSynthesisPort } from "../../src/voice/streamed-playback-port.ts";
import type { TranscriptionEvaluationCorpus } from "../../src/voice/transcription-evaluation.ts";
import { TransportMediaNormalizer } from "../../src/voice/transport-media-normalizer.ts";

/** Fixed patient-free requests. No caller text or recording path can enter this builder. */
export const bookingSpeechPhrases = [
  { id: "date-time", text: "Please book an appointment on Thursday the fifteenth of October at two thirty in the afternoon.", criticalTerms: ["book", "Thursday", "fifteenth", "October", "two", "thirty", "afternoon"] },
  { id: "correction", text: "No, I meant Tuesday at two thirty, not Thursday at three.", criticalTerms: ["No", "Tuesday", "two", "thirty", "not", "Thursday", "three"] },
  { id: "withdrawal", text: "Keep my original appointment. Do not cancel it.", criticalTerms: ["Keep", "original", "not", "cancel"] },
  { id: "duration", text: "Please make that a full hour, not forty five minutes.", criticalTerms: ["full", "hour", "not", "forty", "five"] },
] as const;
export const bookingSpeechVoices = ["coral", "cedar"] as const;
type Voice = typeof bookingSpeechVoices[number];
type Fixture = Readonly<{ id: string; category: string; file: string; expectedText: string; criticalTerms: readonly string[]; pcm: Buffer; condition: "quiet" | "noise10db" }>;
export type BookingSpeechPair = Readonly<{ sourceName: string; text: string; voice: Voice; source: Buffer; measuredSnrDb: number; clippedSamples: number; fixtures: readonly Fixture[] }>;

function noisy(source: Buffer, seed: number) {
  let power = 0; for (let i = 0; i < source.length; i += 2) power += source.readInt16LE(i) ** 2;
  const noisePeak = Math.sqrt(power / (source.length / 2)) * Math.sqrt(3) / Math.sqrt(10);
  const pcm = Buffer.alloc(source.length); let state = seed, noisePower = 0, clippedSamples = 0;
  for (let i = 0; i < source.length; i += 2) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const sample = source.readInt16LE(i), unbounded = Math.round(sample + ((state >>> 0) / 0xffffffff * 2 - 1) * noisePeak);
    const mixed = Math.max(-32768, Math.min(32767, unbounded)); if (mixed !== unbounded) clippedSamples++;
    pcm.writeInt16LE(mixed, i); noisePower += (mixed - sample) ** 2;
  }
  return { pcm, clippedSamples, measuredSnrDb: 10 * Math.log10(power / noisePower) };
}

function telephone(source: Buffer): Buffer {
  const encoded = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1", "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], { input: source, maxBuffer: 1_000_000 });
  if (encoded.length < 160) throw new Error("synthetic telephone audio unavailable");
  const normalizer = new TransportMediaNormalizer("pcmu/8000"), frames: Uint8Array[] = [];
  for (let offset = 0, sequence = 0; offset < encoded.length; offset += 160, sequence++) {
    const payload = new Uint8Array(160).fill(0xff); payload.set(encoded.subarray(offset, offset + 160));
    const frame = normalizer.normalize({ sessionId: "synthetic-booking-fixture", sequence, capturedAt: new Date(Date.UTC(2026, 9, 6) + sequence * 20).toISOString(), payload });
    if (!frame.ok) throw new Error("synthetic telephone audio unavailable"); frames.push(frame.value.bytes);
  }
  return Buffer.concat(frames);
}

/** Each source is rendered once, then shared by its quiet/noisy pair. Provider
 * transcript validation belongs to the injected production synthesis adapter;
 * independent ASR and human acoustic review remain separate evidence. */
export async function* buildBookingSpeechPairs(factory: (voice: Voice) => SpeechSynthesisPort, signal: AbortSignal): AsyncGenerator<BookingSpeechPair> {
  let sequence = 0, sourceIndex = 0;
  for (const voice of bookingSpeechVoices) for (const phrase of bookingSpeechPhrases) {
    if (signal.aborted) throw new Error("synthetic generation aborted");
    const chunks: Buffer[] = []; let size = 0, peak = 0;
    for await (const bytes of factory(voice).stream(phrase.text, signal)) {
      if (signal.aborted || !(bytes instanceof Uint8Array) || bytes.length < 320 || bytes.length > 3200 || bytes.length % 32 || (size += bytes.length) > 640_000) throw new Error("invalid generated synthetic audio");
      const chunk = Buffer.from(bytes); for (let i = 0; i < chunk.length; i += 2) peak = Math.max(peak, Math.abs(chunk.readInt16LE(i))); chunks.push(chunk);
    }
    if (signal.aborted || !peak || size < 640) throw new Error("invalid generated synthetic audio");
    const source = Buffer.concat(chunks), noise = noisy(source, 0x4140 + sourceIndex++);
    if (noise.clippedSamples || !Number.isFinite(noise.measuredSnrDb)) throw new Error("clipped synthetic fixture");
    const fixtures = (["quiet", "noise10db"] as const).map(condition => ({ id: `BK-${String(++sequence).padStart(3, "0")}`, category: `${phrase.id}-${voice}-${condition === "quiet" ? "quiet" : "noise"}`,
      file: `booking-${phrase.id}-${voice}-${condition}-pcmu.pcm`, expectedText: phrase.text, criticalTerms: phrase.criticalTerms,
      pcm: telephone(condition === "quiet" ? source : noise.pcm), condition }));
    yield { sourceName: `source-${phrase.id}-${voice}.pcm`, text: phrase.text, voice, source, measuredSnrDb: noise.measuredSnrDb, clippedSamples: noise.clippedSamples, fixtures };
  }
}

export function pcm16Wav(pcm: Uint8Array): Buffer {
  if (pcm.length < 640 || pcm.length % 2) throw new Error("invalid synthetic PCM");
  const wav = Buffer.alloc(44 + pcm.length); wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); wav.set(pcm, 44); return wav;
}

export function bookingCorpus(cases: TranscriptionEvaluationCorpus["cases"]): TranscriptionEvaluationCorpus {
  return { schemaVersion: 1, version: "transcription-booking-v1", audioFormat: "mono-pcm16le-16000", cases };
}
