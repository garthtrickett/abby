import { createHash } from "node:crypto";

/** Compare a reader and its budget without revealing or persisting the API credential. */
export function clinikoCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update("abby-cliniko-credential-v1\0").update(apiKey).digest("hex");
}

export type ClinikoRateLimit = Readonly<{ kind: "rateLimited"; resetAt?: string }>;
export type ClinikoBudgetDenial = ClinikoRateLimit | Readonly<{ kind: "unavailable" }>;

/** The host owns one budget per Cliniko API user; adapters reserve before every request. */
export type ClinikoRequestBudget = Readonly<{
  claim(): ClinikoBudgetDenial | null | Promise<ClinikoBudgetDenial | null>;
  observe429(resetHeader: string | null): ClinikoRateLimit | Promise<ClinikoRateLimit>;
}>;

export function isClinikoRequestBudget(value: unknown): value is ClinikoRequestBudget {
  return typeof value === "object" && value !== null &&
    typeof (value as ClinikoRequestBudget).claim === "function" &&
    typeof (value as ClinikoRequestBudget).observe429 === "function";
}

function normalizedLimit(value: unknown): ClinikoRateLimit | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Partial<ClinikoRateLimit>;
  if (result.kind !== "rateLimited") return null;
  if (result.resetAt === undefined) return { kind: "rateLimited" };
  return typeof result.resetAt === "string" && Number.isFinite(Date.parse(result.resetAt))
    ? { kind: "rateLimited", resetAt: result.resetAt } : null;
}

function normalizedDenial(value: unknown): ClinikoBudgetDenial | null {
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "unavailable") {
    return { kind: "unavailable" };
  }
  return normalizedLimit(value);
}

/** A failed or malformed host reservation cannot authorize a provider request. */
export async function claimClinikoBudget(budget: ClinikoRequestBudget): Promise<ClinikoBudgetDenial | null> {
  try {
    const result: unknown = await budget.claim();
    if (result === null) return null;
    const denied = normalizedDenial(result);
    if (denied) return denied;
  } catch { /* Budget failure closes the request path. */ }
  return { kind: "unavailable" };
}

export async function observeCliniko429(budget: ClinikoRequestBudget,
                                  resetHeader: string | null): Promise<ClinikoRateLimit> {
  try {
    const result: unknown = await budget.observe429(resetHeader);
    const limited = normalizedLimit(result);
    if (limited) return limited;
  } catch { /* Budget failure closes the request path. */ }
  return { kind: "rateLimited" };
}

/** A process-local budget shared by readers using the same Cliniko API user. */
export class ClinikoReadBudget implements ClinikoRequestBudget {
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
  claim(): ClinikoRateLimit | null {
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
  observe429(resetHeader: string | null): ClinikoRateLimit {
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
