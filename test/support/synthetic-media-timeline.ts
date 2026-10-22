/** Reserve the same42-frame utterance on the synthetic host clock, including
 * after callback delays. The first frame must follow the last played prompt. */
export function alignedSyntheticReplyEnd(hostElapsedMs: number, requestedEndMs: number): number {
  if (![hostElapsedMs, requestedEndMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 900000))
    throw new Error("invalid synthetic reply clock");
  const aligned = Math.max(hostElapsedMs + 42 * 20, requestedEndMs);
  if (aligned > 900000 || aligned - hostElapsedMs > 15000) throw new Error("synthetic reply exceeds clock bound");
  return aligned;
}

/** Sequence numbers count delivered packets; timestamps describe elapsed audio. */
export class SyntheticMediaTimeline {
  #chunk = 0;
  #elapsedMs = -20;
  get nextTurnEndMs(): number { return this.#elapsedMs + 42 * 20; }
  /** Reconcile a reply of any packet count after delayed silence callbacks.
   * The next delivered packet follows the observed host time; no packet or
   * audio content is invented, and elapsed time can never run backwards. */
  alignAfter(hostElapsedMs: number): void {
    if (!Number.isSafeInteger(hostElapsedMs) || hostElapsedMs < 0 || hostElapsedMs + 20 > 900000 ||
        hostElapsedMs - this.#elapsedMs > 15000) throw new Error("invalid bounded synthetic media alignment");
    this.#elapsedMs = Math.max(this.#elapsedMs, hostElapsedMs);
  }
  alignTurnEnd(hostElapsedMs: number): void {
    const proposed = this.nextTurnEndMs;
    if (!Number.isSafeInteger(hostElapsedMs) || hostElapsedMs < proposed || hostElapsedMs > 900000 || hostElapsedMs - proposed > 15000)
      throw new Error("invalid bounded synthetic media alignment");
    // Missed silence packets advance elapsed time, never packet sequence or
    // audio content. The next42 real frames finish at the confirmed host time.
    this.#elapsedMs = hostElapsedMs - 42 * 20;
  }
  next(): Readonly<{ chunk: string; timestamp: string }> {
    this.#chunk++; this.#elapsedMs += 20;
    return { chunk: String(this.#chunk), timestamp: String(this.#elapsedMs) };
  }
}
