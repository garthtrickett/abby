import WebSocket from "ws";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import type { MediaFrame, TranscriptionFailure, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import type { TranscriptEvent } from "../../src/voice/turn-assembler.ts";

type Final = Result<readonly TranscriptEvent[], TranscriptionFailure>;
type Socket = Pick<WebSocket, "on" | "send" | "close" | "terminate" | "bufferedAmount" | "readyState">;
type Config = Readonly<{ apiKey: string; sessionId: string; transcription: TranscriptionPort;
  fetch?: typeof globalThis.fetch;
  socketFactory?: (url: string, headers: Readonly<Record<string, string>>) => Socket }>;
const unavailable = (): Final => err({ kind: "transcriptionUnavailable" });
const deadlineMs = 2_000;
const frameBytes = 960; // Krisp's required 30 ms, mono PCM16, 16 kHz.

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function sessionKey(config: Config, signal: AbortSignal): Promise<string> {
  const response = await (config.fetch ?? globalThis.fetch)("https://api.developers.krisp.ai/v2/sdk/tokens/session", {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `api-key ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ usage_type: "viva", expiration_ttl: 5 }),
  });
  if (!response.ok || !response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16_384) throw new Error();
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown), data = object(result?.data);
  const key = data?.session_key;
  if (result?.code !== 0 || data?.type !== "session" || data?.usage_type !== "viva" ||
      data?.status !== "LICENSE_VALID" || typeof data.expires_at !== "string" ||
      !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now() ||
      typeof key !== "string" || !key || key.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(key) || key === config.apiKey) throw new Error();
  return key;
}

/** Synthetic evaluation only: one session/one generation, never selected by a serving host.
 * Reframe 20 ms input to 30 ms for Krisp, then restore exactly the original 20 ms
 * sample count before STT. Transport padding is never passed to transcription.
 */
export class KrispEvaluationTranscription implements TranscriptionPort {
  private readonly config: Config;
  private readonly abort = new AbortController();
  private socket: Socket | undefined;
  private ready: Promise<boolean> | undefined;
  private readyResolve: ((value: boolean) => void) | undefined;
  private closed = false;
  private flushing = false;
  private cleanClose = false;
  private input = Buffer.alloc(0);
  private output = Buffer.alloc(0);
  private frames: Omit<MediaFrame, "bytes">[] = [];
  private forwarded = 0;
  private sent = 0;
  private received = 0;
  private queue: Promise<void> = Promise.resolve();
  private completeResolve: (() => void) | undefined;
  private closeResolve: (() => void) | undefined;
  private failureResolve!: (value: Final) => void;
  private readonly failed: Promise<Final>;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private external: AbortSignal | undefined;
  private readonly onAbort = () => { this.fail(); };

  constructor(config: Config) {
    if (!config || typeof config.apiKey !== "string" || !config.apiKey || config.apiKey.length > 512 ||
        /[\s\u0000-\u001f\u007f]/.test(config.apiKey) || typeof config.sessionId !== "string" ||
        !config.sessionId || config.sessionId.length > 200) throw new Error("Krisp evaluation configuration unavailable");
    this.config = Object.freeze({ ...config });
    this.failed = new Promise(resolve => { this.failureResolve = resolve; });
  }

  private cleanup(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.external?.removeEventListener("abort", this.onAbort);
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true; this.cleanup(); this.abort.abort();
    this.readyResolve?.(false); this.failureResolve(unavailable());
    this.input = Buffer.alloc(0); this.output = Buffer.alloc(0); this.frames = [];
    try { this.socket?.terminate(); } catch { /* No provider response or credential escapes. */ }
    try { void this.config.transcription.close?.().catch(() => {}); } catch { /* Same refusal. */ }
  }

  private deadline(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.fail(), deadlineMs); this.timers.add(timer); return timer;
  }

  private start(signal: AbortSignal): Promise<boolean> {
    this.external = signal; signal.addEventListener("abort", this.onAbort, { once: true });
    const timer = this.deadline();
    this.ready = new Promise(resolve => { this.readyResolve = resolve; });
    void (async () => {
      try {
        const token = await sessionKey(this.config, this.abort.signal);
        if (this.closed) return;
        const url = "wss://streaming.krisp.ai/voice-isolation", headers = { Authorization: `api-key ${token}` };
        const socket = this.config.socketFactory?.(url, headers) ??
          new WebSocket(url, { headers, maxPayload: 16_384, handshakeTimeout: deadlineMs });
        this.socket = socket;
        let opened = false, ready = false;
        const open = () => {
          if (this.closed || opened) return;
          opened = true;
          try { socket.send(JSON.stringify({ model: "VIVA-tel", sample_rate: 16_000, suppression_level: 100 })); }
          catch { this.fail(); }
        };
        socket.on("open", open);
        socket.on("error", () => this.fail());
        socket.on("close", (code: number) => {
          if (this.closed) return;
          if (!this.cleanClose || code !== 1000) { this.fail(); return; }
          this.closeResolve?.();
        });
        socket.on("message", (raw: WebSocket.RawData, binary: boolean) => {
          if (this.closed) return;
          try {
            const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            if (!opened || bytes.length > 16_384) throw new Error();
            if (!ready) {
              if (binary || object(JSON.parse(bytes.toString("utf8")) as unknown)?.type !== "ready") throw new Error();
              ready = true; clearTimeout(timer); this.timers.delete(timer); this.readyResolve?.(true); return;
            }
            if (!binary || this.cleanClose || bytes.length !== frameBytes || this.received >= this.sent) throw new Error();
            this.received++;
            this.output = Buffer.concat([this.output, bytes]);
            while (this.output.length >= 640 && this.forwarded < this.frames.length) {
              const frame = { ...this.frames[this.forwarded++]!, bytes: Buffer.from(this.output.subarray(0, 640)) };
              this.output = Buffer.from(this.output.subarray(640));
              this.queue = this.queue.then(async () => {
                if (this.closed) return;
                const result = await this.config.transcription.accept(frame, 1, this.abort.signal);
                if (!result.ok || result.value.length !== 0) this.fail();
              }).catch(() => this.fail());
            }
            if (this.flushing && this.received === this.sent) this.completeResolve?.();
          } catch { this.fail(); }
        });
        if (socket.readyState === WebSocket.OPEN) open();
        else if (socket.readyState !== WebSocket.CONNECTING) this.fail();
      } catch { this.fail(); }
    })();
    if (signal.aborted) this.fail();
    return this.ready;
  }

  private send(bytes: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !Number.isFinite(socket.bufferedAmount) ||
        socket.bufferedAmount < 0 || socket.bufferedAmount > 1_000_000) throw new Error();
    this.sent++; socket.send(bytes);
  }

  async accept(frame: MediaFrame, generation: number, signal: AbortSignal): Promise<Final> {
    if (this.closed || this.flushing || generation !== 1 || !(signal instanceof AbortSignal) || !frame ||
        frame.sessionId !== this.config.sessionId || frame.sequence !== this.frames.length ||
        typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt)) || !(frame.bytes instanceof Uint8Array) ||
        frame.bytes.length !== 640 || this.frames.length >= 1_562) return unavailable();
    if (signal.aborted) { this.fail(); return unavailable(); }
    if (this.external && this.external !== signal) return unavailable();
    if (!await (this.ready ?? this.start(signal)) || this.closed || this.flushing ||
        frame.sequence !== this.frames.length) return unavailable();
    try {
      this.frames.push({ sessionId: frame.sessionId, sequence: frame.sequence, capturedAt: frame.capturedAt });
      this.input = Buffer.concat([this.input, frame.bytes]);
      while (this.input.length >= frameBytes) {
        const chunk = Buffer.from(this.input.subarray(0, frameBytes));
        this.input = Buffer.from(this.input.subarray(frameBytes)); this.send(chunk);
      }
      return this.closed ? unavailable() : ok([]);
    } catch { this.fail(); return unavailable(); }
  }

  async flush(generation: number, signal: AbortSignal): Promise<Final> {
    if (this.closed || this.flushing || generation !== 1 || !this.frames.length || !(signal instanceof AbortSignal)) return unavailable();
    this.flushing = true;
    signal.addEventListener("abort", this.onAbort, { once: true });
    const timer = this.deadline(); // Shared 2 s: denoiser tail + close + transcription finality.
    try {
      if (signal.aborted) { this.fail(); return unavailable(); }
      const process = async (): Promise<Final> => {
        const complete = new Promise<void>(resolve => { this.completeResolve = resolve; });
        if (this.input.length) {
          const padded = Buffer.alloc(frameBytes); this.input.copy(padded); this.input = Buffer.alloc(0); this.send(padded);
        }
        if (this.received !== this.sent) await complete;
        await this.queue;
        if (this.closed || this.forwarded !== this.frames.length ||
            this.output.length !== this.sent * frameBytes - this.frames.length * 640) { this.fail(); return unavailable(); }
        const close = new Promise<void>(resolve => { this.closeResolve = resolve; });
        this.cleanClose = true; this.socket!.close(1000); await close;
        if (this.closed) return unavailable();
        return await this.config.transcription.flush(1, this.abort.signal);
      };
      const result = await Promise.race([process().catch(() => { this.fail(); return unavailable(); }), this.failed]);
      this.fail(); // Retire both providers even after success; no reuse or implicit retry.
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", this.onAbort); }
  }

  async cancel(generation: number): Promise<void> { if (generation === 1) this.fail(); }
  async close(): Promise<void> { this.fail(); }
}
