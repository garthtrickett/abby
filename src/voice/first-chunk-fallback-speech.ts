import type { SpeechSynthesisPort } from "./streamed-playback-port.ts";

export type FirstChunkFallbackSpeechConfig = Readonly<{
  primary: SpeechSynthesisPort;
  fallback: SpeechSynthesisPort;
  primaryFirstChunkMs: number;
  /** PHI-free diagnostic; never receives approved text or audio. */
  onSelection?: (source: "primary" | "fallback") => void;
}>;

function validChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength >= 320 &&
    value.byteLength <= 3_200 && value.byteLength % 32 === 0;
}

/** Switches providers only before the first chunk, when no caller audio can have been queued. */
export class FirstChunkFallbackSpeech implements SpeechSynthesisPort {
  private readonly config: FirstChunkFallbackSpeechConfig;

  constructor(config: FirstChunkFallbackSpeechConfig) {
    if (!config || !config.primary || !config.fallback ||
        !Number.isSafeInteger(config.primaryFirstChunkMs) || config.primaryFirstChunkMs < 50 ||
        config.primaryFirstChunkMs > 5_000 ||
        (config.onSelection !== undefined && typeof config.onSelection !== "function")) {
      throw new RangeError("invalid speech fallback configuration");
    }
    this.config = config;
  }

  async *stream(approvedText: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (signal.aborted) throw new Error("speech canceled");
    const primaryAbort = new AbortController();
    const cancelPrimary = () => primaryAbort.abort();
    signal.addEventListener("abort", cancelPrimary, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      iterator = this.config.primary.stream(approvedText, primaryAbort.signal)[Symbol.asyncIterator]();
      const first = await Promise.race([
        Promise.resolve().then(() => iterator!.next()).then(value => ({ kind: "next" as const, value }),
          () => ({ kind: "failed" as const })),
        new Promise<{ kind: "timeout" }>(resolve => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), this.config.primaryFirstChunkMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (signal.aborted) throw new Error("speech canceled");
      if (first.kind === "next" && !first.value.done && validChunk(first.value.value)) {
        try { this.config.onSelection?.("primary"); } catch { /* diagnostic cannot change speech */ }
        yield first.value.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      }
      primaryAbort.abort();
      try { void iterator.return?.().catch(() => undefined); } catch { /* cancellation is best effort */ }
      if (signal.aborted) throw new Error("speech canceled");
      try { this.config.onSelection?.("fallback"); } catch { /* diagnostic cannot change speech */ }
      yield* this.config.fallback.stream(approvedText, signal);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", cancelPrimary);
      primaryAbort.abort();
    }
  }
}
