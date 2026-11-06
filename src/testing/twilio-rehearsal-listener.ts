/** Test-only, bounded metadata from Twilio's two caller-leg media tracks.
 * Payload bytes are decoded for energy and immediately discarded. This does
 * not qualify intelligibility or audible interruption by itself. */
type Track = "inbound" | "outbound";
type Frame = Readonly<{ atMs: number; durationMs: number; meanAbsPcm: number }>;
type TrackState = { lastEndMs: number; gaps: number; frames: Frame[] };
const sid = (prefix: string, value: unknown): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}[0-9a-f]{32}$`, "i").test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,8})$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
};

function meanAbsMulaw(bytes: Buffer): number {
  let total = 0;
  for (const byte of bytes) {
    const code = (~byte) & 0xff;
    const magnitude = (((code & 15) << 3) + 132) << ((code >> 4) & 7);
    total += Math.abs(magnitude - 132);
  }
  return Math.round(total / bytes.length);
}

function silenceCandidate(inbound: readonly Frame[], outbound: readonly Frame[]):
  Readonly<{ secondUtteranceAtMs: number; targetActiveBeforeMs: number;
    candidateSilenceLagMs: number }> | undefined {
  const loud = (frame: Frame) => frame.meanAbsPcm >= 700;
  const bursts: { start: number; end: number; activeMs: number }[] = [];
  for (const frame of outbound) {
    if (!loud(frame)) continue;
    const last = bursts.at(-1);
    if (!last || frame.atMs - last.end > 500) bursts.push({ start: frame.atMs,
      end: frame.atMs + frame.durationMs, activeMs: frame.durationMs });
    else { last.end = frame.atMs + frame.durationMs; last.activeMs += frame.durationMs; }
  }
  if (bursts.length !== 2 || bursts[0]!.activeMs < 80 || bursts[1]!.activeMs < 80 ||
      bursts[1]!.start - bursts[0]!.end < 1_500 ||
      bursts[1]!.start - bursts[0]!.end > 5_000) return undefined;
  const onset = bursts[1]!.start;
  const before = inbound.reduce((total, frame) => total +
    (loud(frame) && frame.atMs >= onset - 500 && frame.atMs < onset ? frame.durationMs : 0), 0);
  if (before < 100 || !inbound.some(frame => loud(frame) &&
      frame.atMs < onset && frame.atMs + frame.durationMs > onset - 100) ||
      !inbound.some(frame => frame.atMs >= onset + 1_500)) return undefined;
  const coverageStart = onset - 500, coverageEnd = onset + 1_500;
  let coveredThrough = coverageStart;
  for (const frame of inbound) {
    if (frame.atMs + frame.durationMs <= coverageStart || frame.atMs >= coverageEnd) continue;
    if (frame.atMs - coveredThrough > 40) return undefined;
    coveredThrough = Math.max(coveredThrough, frame.atMs + frame.durationMs);
  }
  if (coveredThrough < coverageEnd) return undefined;
  let quietAt: number | undefined;
  for (const frame of inbound) {
    if (frame.atMs + frame.durationMs <= onset) continue;
    if (frame.atMs > onset + 1_500) break;
    if (loud(frame)) quietAt = undefined;
    else {
      quietAt ??= Math.max(onset, frame.atMs);
      if (frame.atMs + frame.durationMs - quietAt >= 200)
        return { secondUtteranceAtMs: onset, targetActiveBeforeMs: before,
          candidateSilenceLagMs: quietAt - onset };
    }
  }
  return undefined;
}

export class RehearsalListenerFrames {
  readonly #accountSid: string;
  readonly #runId: string;
  #phase: "connected" | "started" | "stopped" | "failed" | "new" = "new";
  #sequence = 0;
  #mediaChunk = 0;
  #streamSid: string | undefined;
  #streamCallSid: string | undefined;
  #boundCallSid: string | undefined;
  #reason: string | undefined;
  readonly #tracks: Record<Track, TrackState> = {
    inbound: { lastEndMs: 0, gaps: 0, frames: [] },
    outbound: { lastEndMs: 0, gaps: 0, frames: [] },
  };

  constructor(accountSid: string, runId: string) {
    if (!sid("AC", accountSid) || !/^[a-f0-9]{32}$/.test(runId)) throw Error("Invalid listener identity");
    this.#accountSid = accountSid;
    this.#runId = runId;
  }

  bindCall(callSid: string): void {
    if (this.#boundCallSid || !sid("CA", callSid)) throw Error("Invalid caller binding");
    this.#boundCallSid = callSid;
    if (this.#streamCallSid && this.#streamCallSid !== callSid) this.#fail("callerMismatch");
  }

  #fail(reason: string): false { this.#phase = "failed"; this.#reason = reason; return false; }

  accept(raw: string): boolean {
    if (this.#phase === "failed" || this.#phase === "stopped") return false;
    if (Buffer.byteLength(raw) > 16_384) return this.#fail("oversizeFrame");
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return this.#fail("invalidFrame"); }
    if (!object(message)) return this.#fail("invalidFrame");
    if (this.#phase === "new") {
      if (message.event !== "connected" || message.protocol !== "Call" ||
          message.version !== "1.0.0") return this.#fail("missingConnected");
      this.#phase = "connected";
      return true;
    }
    const seq = number(message.sequenceNumber);
    if (seq !== this.#sequence + 1) return this.#fail("sequenceGap");
    this.#sequence = seq;
    if (this.#phase === "connected") {
      const start = message.start;
      if (message.event !== "start" || !object(start) ||
          start.accountSid !== this.#accountSid || !sid("CA", start.callSid) ||
          !sid("MZ", start.streamSid) || message.streamSid !== start.streamSid ||
          !Array.isArray(start.tracks) || start.tracks.length !== 2 ||
          !start.tracks.includes("inbound") || !start.tracks.includes("outbound") ||
          !object(start.mediaFormat) || start.mediaFormat.encoding !== "audio/x-mulaw" ||
          start.mediaFormat.sampleRate !== 8_000 || start.mediaFormat.channels !== 1 ||
          !object(start.customParameters) || start.customParameters.runId !== this.#runId) {
        return this.#fail("invalidStart");
      }
      this.#streamSid = start.streamSid;
      this.#streamCallSid = start.callSid;
      if (this.#boundCallSid && this.#boundCallSid !== start.callSid) return this.#fail("callerMismatch");
      this.#phase = "started";
      return true;
    }
    if (message.streamSid !== this.#streamSid) return this.#fail("streamMismatch");
    if (message.event === "stop") {
      const stop = message.stop;
      if (!object(stop) || stop.accountSid !== this.#accountSid ||
          stop.callSid !== this.#streamCallSid) return this.#fail("invalidStop");
      this.#phase = "stopped";
      return true;
    }
    const media = message.media;
    if (message.event !== "media" || !object(media) ||
        (media.track !== "inbound" && media.track !== "outbound") ||
        typeof media.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(media.payload)) {
      return this.#fail("invalidMedia");
    }
    const track = this.#tracks[media.track as Track];
    const chunk = number(media.chunk), atMs = number(media.timestamp);
    // Twilio numbers media chunks across both tracks, while timestamps and
    // signal coverage belong to each track independently.
    if (chunk !== this.#mediaChunk + 1 || atMs === undefined ||
        track.frames.length >= 10_000) return this.#fail("mediaGapOrLimit");
    const bytes = Buffer.from(media.payload, "base64");
    if (bytes.length < 80 || bytes.length > 800 ||
        bytes.toString("base64") !== media.payload || bytes.length % 8 !== 0) {
      return this.#fail("invalidPayload");
    }
    const durationMs = bytes.length / 8;
    if (track.frames.length && atMs < track.lastEndMs) return this.#fail("overlappingTimestamp");
    if (track.frames.length && atMs - track.lastEndMs > 40) track.gaps++;
    this.#mediaChunk = chunk;
    track.lastEndMs = atMs + durationMs;
    track.frames.push({ atMs, durationMs, meanAbsPcm: meanAbsMulaw(bytes) });
    return true;
  }

  finish(): void {
    if (this.#phase !== "stopped" && this.#phase !== "failed") this.#fail("missingStop");
  }

  /** Caller-leg inbound is Abby heard by the scripted caller; outbound is the
   * scripted TwiML speech delivered to Abby. These energies are diagnostic only. */
  summary(): Readonly<{ status: "captured" | "unverified"; reason?: string;
    inboundFrames: number; outboundFrames: number; inboundActiveMs: number; outboundActiveMs: number;
    inboundGaps: number; outboundGaps: number;
    silenceCandidate?: ReturnType<typeof silenceCandidate> }> {
    const inbound = this.#tracks.inbound.frames, outbound = this.#tracks.outbound.frames;
    const result = { inboundFrames: inbound.length, outboundFrames: outbound.length,
      inboundGaps: this.#tracks.inbound.gaps, outboundGaps: this.#tracks.outbound.gaps,
      inboundActiveMs: inbound.reduce((n, f) => n + (f.meanAbsPcm >= 700 ? f.durationMs : 0), 0),
      outboundActiveMs: outbound.reduce((n, f) => n + (f.meanAbsPcm >= 700 ? f.durationMs : 0), 0) };
    const candidate = silenceCandidate(inbound, outbound);
    return this.#phase === "stopped" && this.#boundCallSid === this.#streamCallSid &&
      inbound.length > 0 && outbound.length > 0
      ? { status: "captured", ...result, ...(candidate ? { silenceCandidate: candidate } : {}) }
      : { status: "unverified", reason: this.#reason ?? "incompleteOrUnbound", ...result };
  }
}
