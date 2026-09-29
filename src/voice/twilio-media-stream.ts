import { randomUUID } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { MediaFrame } from "./media-turn-controller.ts";
import type { AudioOutputPort, PlaybackCompletion } from "./streamed-playback-port.ts";
import { TransportMediaNormalizer } from "./transport-media-normalizer.ts";

const sid = /^(?:AC|CA|MZ)[0-9a-f]{32}$/i;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const maxMessageBytes = 16_384;
const maxStreamMs = 4 * 60 * 60 * 1_000;
type SendResult = "queued" | "notSent" | "uncertain";
type OutputState = { playbackId: string; nextSequence: number; finished: boolean; markName?: string };
type Mark = { kind: "completion"; playbackId: string; lastSequence: number } |
  { kind: "fence"; resolve: (value: boolean) => void };

export type TwilioStreamConfig = Readonly<{
  /** These values must come from a validated Twilio webhook and signed WebSocket upgrade. */
  accountSid: string;
  callSid: string;
  sessionId: string;
  startedAt: string;
  send: (json: string) => SendResult;
  clearDeadlineMs?: number;
}>;
export type TwilioStreamEvent =
  | Readonly<{ kind: "connected" | "started" | "ignoredMark" | "stopped" }>
  | Readonly<{ kind: "media"; frame: MediaFrame }>
  | Readonly<{ kind: "played"; completion: PlaybackCompletion }>
  | Readonly<{ kind: "dtmf"; digit: string }>;
export type TwilioStreamFailure = Readonly<{ kind: "invalidMedia" | "streamClosed" | "streamUnavailable" }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function decodePayload(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length < 108 || value.length > 1_068 || !base64.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

function pcmu(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const biased = Math.min(32_635, Math.abs(sample)) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (biased & mask) === 0; mask >>= 1) exponent -= 1;
  return (~(sign | (exponent << 4) | ((biased >> (exponent + 3)) & 0x0f))) & 0xff;
}

function encodePcm16ToPcmu(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Uint8Array(bytes.length / 4);
  for (let index = 0; index < output.length; index += 1) {
    const first = view.getInt16(index * 4, true);
    const second = view.getInt16(index * 4 + 2, true);
    output[index] = pcmu(Math.round((first + second) / 2));
  }
  return output;
}

/** One already-authenticated bidirectional Twilio Media Stream. No audio or caller content is persisted. */
export class TwilioMediaStream implements AudioOutputPort {
  private readonly config: TwilioStreamConfig;
  private readonly normalizer = new TransportMediaNormalizer("pcmu/8000");
  private readonly startedMs: number;
  private readonly clearDeadlineMs: number;
  private phase: "new" | "connected" | "started" | "closed" = "new";
  private streamSid: string | undefined;
  private nextEventSequence = 1;
  private nextMediaChunk = 1;
  private lastMediaTimestamp = -1;
  private output: OutputState | undefined;
  private marks = new Map<string, Mark>();
  private clearing: Promise<boolean> | undefined;
  private fencing = false;

  constructor(config: TwilioStreamConfig) {
    const startedMs = Date.parse(config?.startedAt);
    const clearDeadlineMs = config?.clearDeadlineMs ?? 2_000;
    if (!config || !sid.test(config.accountSid) || !config.accountSid.startsWith("AC") ||
        !sid.test(config.callSid) || !config.callSid.startsWith("CA") ||
        !config.sessionId?.trim() || config.sessionId.length > 256 || !Number.isFinite(startedMs) ||
        typeof config.send !== "function" || !Number.isSafeInteger(clearDeadlineMs) ||
        clearDeadlineMs < 50 || clearDeadlineMs > 10_000) throw new RangeError("invalid Twilio stream configuration");
    this.config = config;
    this.startedMs = startedMs;
    this.clearDeadlineMs = clearDeadlineMs;
  }

  private send(event: object): SendResult {
    if (this.phase !== "started") return "notSent";
    try {
      const result = this.config.send(JSON.stringify(event));
      return result === "queued" || result === "notSent" || result === "uncertain" ? result : "uncertain";
    }
    catch { return "uncertain"; }
  }

  private fail(): Result<never, TwilioStreamFailure> {
    this.close();
    return err({ kind: "invalidMedia" });
  }

  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    for (const mark of this.marks.values()) if (mark.kind === "fence") mark.resolve(false);
    this.marks.clear();
    this.output = undefined;
  }

  receive(raw: string | Uint8Array): Result<TwilioStreamEvent, TwilioStreamFailure> {
    if (this.phase === "closed") return err({ kind: "streamClosed" });
    if (!(typeof raw === "string" || raw instanceof Uint8Array) ||
        (typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > maxMessageBytes) return this.fail();
    let event: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(raw.toString());
      if (!record(decoded)) return this.fail();
      event = decoded;
    } catch { return this.fail(); }
    if (this.phase === "new") {
      if (event.event !== "connected" || event.protocol !== "Call" || event.version !== "1.0.0") return this.fail();
      this.phase = "connected";
      return ok({ kind: "connected" });
    }
    const sequence = decimal(event.sequenceNumber, 1, Number.MAX_SAFE_INTEGER);
    if (sequence !== this.nextEventSequence) return this.fail();
    this.nextEventSequence += 1;
    if (this.phase === "connected") {
      const start = event.start;
      if (event.event !== "start" || !record(start) || sequence !== 1 ||
          typeof event.streamSid !== "string" || !/^MZ[0-9a-f]{32}$/i.test(event.streamSid) ||
          start.streamSid !== event.streamSid || start.accountSid !== this.config.accountSid ||
          start.callSid !== this.config.callSid || !Array.isArray(start.tracks) ||
          start.tracks.length !== 1 || start.tracks[0] !== "inbound" ||
          !record(start.mediaFormat) || start.mediaFormat.encoding !== "audio/x-mulaw" ||
          start.mediaFormat.sampleRate !== 8000 || start.mediaFormat.channels !== 1) return this.fail();
      this.streamSid = event.streamSid;
      this.phase = "started";
      return ok({ kind: "started" });
    }
    if (event.streamSid !== this.streamSid) return this.fail();
    if (event.event === "stop") {
      if (!record(event.stop) || event.stop.accountSid !== this.config.accountSid ||
          event.stop.callSid !== this.config.callSid) return this.fail();
      this.close();
      return ok({ kind: "stopped" });
    }
    if (event.event === "dtmf") {
      if (!record(event.dtmf) || event.dtmf.track !== "inbound_track" ||
          typeof event.dtmf.digit !== "string" || !/^[0-9*#ABCD]$/.test(event.dtmf.digit)) return this.fail();
      return ok({ kind: "dtmf", digit: event.dtmf.digit });
    }
    if (event.event === "media") {
      if (!record(event.media) || event.media.track !== "inbound") return this.fail();
      const chunk = decimal(event.media.chunk, 1, Number.MAX_SAFE_INTEGER);
      const timestamp = decimal(event.media.timestamp, 0, maxStreamMs);
      const payload = decodePayload(event.media.payload);
      if (chunk !== this.nextMediaChunk || timestamp === undefined || timestamp < this.lastMediaTimestamp || !payload) return this.fail();
      const frame = this.normalizer.normalize({ sessionId: this.config.sessionId,
        sequence: this.nextMediaChunk - 1, capturedAt: new Date(this.startedMs + timestamp).toISOString(), payload });
      if (!frame.ok) return this.fail();
      this.nextMediaChunk += 1;
      this.lastMediaTimestamp = timestamp;
      return ok({ kind: "media", frame: frame.value });
    }
    if (event.event === "mark") {
      if (!record(event.mark) || typeof event.mark.name !== "string") return this.fail();
      const mark = this.marks.get(event.mark.name);
      if (!mark) return this.fail();
      this.marks.delete(event.mark.name);
      if (mark.kind === "fence") { mark.resolve(true); return ok({ kind: "ignoredMark" }); }
      if (this.clearing || this.output?.markName !== event.mark.name) return ok({ kind: "ignoredMark" });
      this.output = undefined;
      return ok({ kind: "played", completion: { playbackId: mark.playbackId,
        lastSequence: mark.lastSequence, status: "played" } });
    }
    return this.fail();
  }

  async queueChunk(playbackId: string, sequence: number, bytes: Uint8Array, signal: AbortSignal):
    Promise<SendResult> {
    if (this.phase !== "started" || signal.aborted || !playbackId?.trim() ||
        !Number.isSafeInteger(sequence) || sequence < 0 || !(bytes instanceof Uint8Array) ||
        bytes.length < 320 || bytes.length > 3_200 || bytes.length % 32 !== 0 || this.fencing) return "notSent";
    if (this.output && (this.output.playbackId !== playbackId || this.output.finished ||
        this.output.nextSequence !== sequence)) return "notSent";
    if (!this.output && sequence !== 0) return "notSent";
    const state = this.output ?? { playbackId, nextSequence: 0, finished: false };
    this.output = state;
    const payload = Buffer.from(encodePcm16ToPcmu(bytes)).toString("base64");
    const result = this.send({ event: "media", streamSid: this.streamSid, media: { payload } });
    if (result === "queued") state.nextSequence += 1;
    return result;
  }

  async finishQueue(playbackId: string, lastSequence: number, signal: AbortSignal): Promise<SendResult> {
    const state = this.output;
    if (this.phase !== "started" || signal.aborted || this.fencing || !state || state.finished ||
        state.playbackId !== playbackId || state.nextSequence < 1 || lastSequence !== state.nextSequence - 1) return "notSent";
    const name = randomUUID();
    state.finished = true;
    state.markName = name;
    this.marks.set(name, { kind: "completion", playbackId, lastSequence });
    const sent = this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
    if (sent !== "queued") { this.marks.delete(name); return "uncertain"; }
    return "queued";
  }

  async clear(playbackId: string): Promise<boolean> {
    if (this.phase !== "started" || !playbackId?.trim()) return false;
    if (this.clearing) return this.clearing;
    if (this.fencing) return false;
    if (this.output && this.output.playbackId !== playbackId) return false;
    const name = randomUUID();
    this.fencing = true;
    this.output = undefined;
    this.clearing = new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: boolean) => { if (timer) clearTimeout(timer); resolve(value); };
      this.marks.set(name, { kind: "fence", resolve: settle });
      const marked = this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
      const cleared = marked === "queued" ? this.send({ event: "clear", streamSid: this.streamSid }) : "notSent";
      if (marked !== "queued" || cleared !== "queued") {
        this.marks.delete(name);
        settle(false);
      } else timer = setTimeout(() => { this.marks.delete(name); settle(false); }, this.clearDeadlineMs);
    }).then(result => { if (!result) this.close(); return result; })
      .finally(() => { this.clearing = undefined; this.fencing = false; });
    return this.clearing;
  }
}
