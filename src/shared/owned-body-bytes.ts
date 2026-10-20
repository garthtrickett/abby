import { setImmediate as yieldToLoop } from "node:timers/promises";

/** Only the owned default reader is needed; Node's HTTP-to-Web adapter and
 * fetch bodies need not agree on unrelated pipeThrough/BYOB overload types. */
export type OwnedBodyStream = Readonly<{ getReader(): {
  read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
  cancel(): Promise<void>;
  releaseLock(): void;
} }>;

export class OwnedBodyError extends Error {
  readonly kind: "malformed" | "unavailable";
  constructor(kind: "malformed" | "unavailable") { super("Body unavailable"); this.kind = kind; }
}

/** Own one bounded body reader. Yield periodically so an immediately producing
 * stream cannot starve its owner's deadline/abort. Cancellation never has to
 * settle before the reader is retired. No body or upstream error escapes. */
export async function ownedBodyBytes(body: OwnedBodyStream | null, maximum: number,
                                      signal: AbortSignal): Promise<Uint8Array> {
  if (!body || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) throw new OwnedBodyError("malformed");
  if (signal.aborted) throw new OwnedBodyError("unavailable");
  let reader: ReturnType<OwnedBodyStream["getReader"]> | undefined, onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new OwnedBodyError("unavailable"));
    signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
  });
  void stopped.catch(() => {});
  try {
    reader = body.getReader();
    // Bound storage independently of the number and size of upstream chunks.
    const bytes = new Uint8Array(maximum); let size = 0, reads = 0;
    for (;;) {
      if (signal.aborted) throw new OwnedBodyError("unavailable");
      const next = await Promise.race([reader.read(), stopped]);
      if (signal.aborted) throw new OwnedBodyError("unavailable");
      if (next.done) return bytes.subarray(0, size);
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > maximum - size) throw new OwnedBodyError("malformed");
      bytes.set(next.value, size); size += next.value.byteLength;
      if (++reads % 64 === 0) await Promise.race([yieldToLoop(), stopped]);
    }
  } catch (error) {
    throw error instanceof OwnedBodyError ? error : new OwnedBodyError("unavailable");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      try { void reader.cancel().catch(() => {}); } catch { /* A bad cancel port cannot prevent retiring our reader. */ }
      try { reader.releaseLock(); } catch { /* Cancellation owns the outstanding read. */ }
    }
  }
}
