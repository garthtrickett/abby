/** A process-local budget shared by readers using the same Cliniko API user. */
export class ClinikoReadBudget {
  private readonly sentAt: number[] = [];
  private cooldownUntil = 0;
  private readonly maxPerMinute: number;
  private readonly clock: () => number;

  constructor(maxPerMinute = 200, clock: () => number = Date.now) {
    if (!Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 200 || typeof clock !== "function") {
      throw new Error("invalid Cliniko read budget");
    }
    this.maxPerMinute = maxPerMinute;
    this.clock = clock;
  }

  /** Reserve before sending. Synchronous reservation keeps concurrent callers under one process budget. */
  claim(): Readonly<{ kind: "rateLimited"; resetAt?: string }> | null {
    let now: number;
    try { now = this.clock(); }
    catch { return { kind: "rateLimited" }; }
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "rateLimited" };
    if (now < this.cooldownUntil) return { kind: "rateLimited", resetAt: new Date(this.cooldownUntil).toISOString() };
    while (this.sentAt.length && this.sentAt[0]! <= now - 60_000) this.sentAt.shift();
    if (this.sentAt.length >= this.maxPerMinute) {
      return { kind: "rateLimited", resetAt: new Date(this.sentAt[0]! + 60_000).toISOString() };
    }
    this.sentAt.push(now);
    return null;
  }

  /** A provider 429 fences all readers that share this budget, even with a missing reset header. */
  observe429(resetHeader: string | null): Readonly<{ kind: "rateLimited"; resetAt?: string }> {
    let now: number;
    try { now = this.clock(); }
    catch { return { kind: "rateLimited" }; }
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "rateLimited" };
    const seconds = resetHeader && /^[0-9]+$/.test(resetHeader) ? Number(resetHeader) : NaN;
    const providerReset = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000
      ? seconds * 1000 : NaN;
    const until = Number.isSafeInteger(providerReset) && providerReset > now ? providerReset : now + 60_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);
    return { kind: "rateLimited", resetAt: new Date(this.cooldownUntil).toISOString() };
  }
}
