import type { SpeechSynthesisPort } from "./streamed-playback-port.ts";

const endpoint = "https://api.openai.com/v1/audio/speech";
const chunkSamples = 320; // 20 ms at Abby's 16 kHz playback rate.
const maxResponseBytes = 6_000_000;
const voices = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx",
  "sage", "shimmer", "verse", "marin", "cedar"]);

export type OpenAISpeechSynthesisConfig = Readonly<{
  apiKey: string;
  model?: string;
  voice?: string;
  fetchPort?: typeof fetch;
}>;

/** Converts headerless 24 kHz PCM16LE into bounded 16 kHz playback chunks across arbitrary HTTP boundaries. */
class Pcm24To16 {
  private inputIndex = 0;
  private previous = 0;
  private nextOutputTwice = 0;
  private lowByte: number | undefined;
  private chunk = new Uint8Array(chunkSamples * 2);
  private outputSamples = 0;
  private emitted = false;

  private output(value: number, ready: Uint8Array[]): void {
    const sample = Math.max(-32768, Math.min(32767, Math.round(value)));
    const offset = this.outputSamples * 2;
    this.chunk[offset] = sample & 0xff;
    this.chunk[offset + 1] = (sample >> 8) & 0xff;
    this.outputSamples += 1;
    if (this.outputSamples === chunkSamples) {
      ready.push(this.chunk);
      this.chunk = new Uint8Array(chunkSamples * 2);
      this.outputSamples = 0;
      this.emitted = true;
    }
  }

  private acceptSample(sample: number, ready: Uint8Array[]): void {
    const index = this.inputIndex;
    if (index === 0) {
      this.output(sample, ready);
      this.nextOutputTwice = 3;
    } else {
      while (this.nextOutputTwice <= index * 2) {
        const fromPrevious = this.nextOutputTwice - (index - 1) * 2;
        this.output((this.previous * (2 - fromPrevious) + sample * fromPrevious) / 2, ready);
        this.nextOutputTwice += 3;
      }
    }
    this.previous = sample;
    this.inputIndex += 1;
  }

  push(bytes: Uint8Array): readonly Uint8Array[] {
    const ready: Uint8Array[] = [];
    for (const byte of bytes) {
      if (this.lowByte === undefined) this.lowByte = byte;
      else {
        const unsigned = this.lowByte | (byte << 8);
        this.lowByte = undefined;
        this.acceptSample(unsigned < 0x8000 ? unsigned : unsigned - 0x10000, ready);
      }
    }
    return ready;
  }

  finish(): Uint8Array | undefined {
    if (this.lowByte !== undefined || (!this.emitted && this.outputSamples < 160)) {
      throw new Error("speech audio unavailable");
    }
    if (this.outputSamples === 0) return undefined;
    // The playback boundary needs at least 10 ms and a multiple of 16 samples.
    const paddedSamples = Math.max(160, Math.ceil(this.outputSamples / 16) * 16);
    return this.chunk.slice(0, paddedSamples * 2);
  }
}

/** Transient TTS adapter. Playback acknowledgment still belongs to Abby's output transport. */
export class OpenAISpeechSynthesis implements SpeechSynthesisPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly fetchPort: typeof fetch;

  constructor(config: OpenAISpeechSynthesisConfig) {
    if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
        (config.model !== undefined && (typeof config.model !== "string" ||
          !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(config.model))) ||
        (config.voice !== undefined && (typeof config.voice !== "string" || !voices.has(config.voice))) ||
        (config.fetchPort !== undefined && typeof config.fetchPort !== "function")) {
      throw new RangeError("invalid speech synthesis configuration");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o-mini-tts";
    this.voice = config.voice ?? "coral";
    this.fetchPort = config.fetchPort ?? fetch;
  }

  async *stream(approvedText: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (typeof approvedText !== "string" || !approvedText.trim() || approvedText.length > 4_096 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(approvedText) || signal.aborted) {
      throw new Error("speech input unavailable");
    }
    const response = await this.fetchPort(endpoint, { method: "POST", headers: {
      Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ model: this.model, voice: this.voice, input: approvedText,
      response_format: "pcm", stream_format: "audio" }), signal });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const declaredLength = response.headers.get("content-length");
    if (!response.ok || !response.body || /json|text\/|mpeg|mp3|wav/.test(contentType) ||
        (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes))) {
      await response.body?.cancel().catch(() => {});
      throw new Error("speech audio unavailable");
    }
    const reader = response.body.getReader();
    const converter = new Pcm24To16();
    let received = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("speech audio unavailable");
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("speech audio unavailable");
        received += value.byteLength;
        if (received > maxResponseBytes) throw new Error("speech audio unavailable");
        for (const chunk of converter.push(value)) {
          if (signal.aborted) throw new Error("speech audio unavailable");
          yield chunk;
        }
      }
      if (signal.aborted) throw new Error("speech audio unavailable");
      const last = converter.finish();
      if (last) yield last;
    } finally {
      try { await reader.cancel(); } catch { /* provider stream may already be closed */ }
      reader.releaseLock();
    }
  }
}
