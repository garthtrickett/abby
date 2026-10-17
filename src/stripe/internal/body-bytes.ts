import { setImmediate as yieldToLoop } from "node:timers/promises";

/** Only the owned default reader is needed; Node's HTTP-to-Web adapter and
 * fetch bodies need not agree on unrelated pipeThrough/BYOB overload types. */
export type StripeBodyStream = Readonly<{ getReader(): {
  read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
  cancel(): Promise<void>;
  releaseLock(): void;
} }>;

export class StripeBodyError extends Error {
  readonly kind: "malformed" | "unavailable";
  constructor(kind: "malformed" | "unavailable") { super("Stripe body unavailable"); this.kind = kind; }
}

/** Own one bounded body reader. Yield periodically so an immediately producing
 * stream cannot starve its owner's deadline/abort. Cancellation never has to
 * settle before the reader is retired. No body or upstream error escapes. */
export async function stripeBodyBytes(body: StripeBodyStream | null, maximum: number,
                                      signal: AbortSignal): Promise<Uint8Array> {
  if (!body || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) throw new StripeBodyError("malformed");
  if (signal.aborted) throw new StripeBodyError("unavailable");
  let reader: ReturnType<StripeBodyStream["getReader"]> | undefined, onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new StripeBodyError("unavailable"));
    signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
  });
  void stopped.catch(() => {});
  try {
    reader = body.getReader();
    // Bound storage independently of the number and size of upstream chunks.
    const bytes = new Uint8Array(maximum); let size = 0, reads = 0;
    for (;;) {
      if (signal.aborted) throw new StripeBodyError("unavailable");
      const next = await Promise.race([reader.read(), stopped]);
      if (signal.aborted) throw new StripeBodyError("unavailable");
      if (next.done) return bytes.subarray(0, size);
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > maximum - size) throw new StripeBodyError("malformed");
      bytes.set(next.value, size); size += next.value.byteLength;
      if (++reads % 64 === 0) await Promise.race([yieldToLoop(), stopped]);
    }
  } catch (error) {
    throw error instanceof StripeBodyError ? error : new StripeBodyError("unavailable");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* Cancellation owns the outstanding read. */ }
    }
  }
}
