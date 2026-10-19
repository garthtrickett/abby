/** Test-only fixed numeric observations. No native/action/patient/provider IDs,
 * financial values, error strings, payloads or permission cross this interface. */
export type FinancialNativeReadFailure = Readonly<{ reader: number; code: number; afterClaim: boolean }>;
export type FinancialExpiryObservation = Readonly<{
  code: number; claims: number; requests: number; quotaRequired: number; quotaDenials: number; elapsedMs: number; nativeFailure?: FinancialNativeReadFailure;
}>;
const fields = "claims,code,elapsedMs,quotaDenials,quotaRequired,requests";
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const nativeCodes = ["invalidConfig", "invalidQuery", "scopeMismatch", "invalidProof", "forbidden", "unavailable", "malformed", "changed", "tooManyResults", "rateLimited", "mismatched", "notFound"] as const;
export function financialNativeReadCode(value: unknown): number {
  try { const r = value as { ok?: unknown; error?: { kind?: unknown } }; return r?.ok === false ? Math.max(0, nativeCodes.findIndex(k => k === r.error?.kind) + 1) : 0; }
  catch { return 0; }
}
function nativeFailure(value: unknown): FinancialNativeReadFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "afterClaim,code,reader" || !integer(r.reader, 4) || r.reader === 0 || !integer(r.code, nativeCodes.length) || typeof r.afterClaim !== "boolean") return undefined;
  return Object.freeze({ reader: r.reader, code: r.code, afterClaim: r.afterClaim });
}
export function financialExpiryObservation(value: unknown): FinancialExpiryObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort().join(","), failure = Object.hasOwn(row, "nativeFailure") ? nativeFailure(row.nativeFailure) : undefined;
    if ((keys !== fields && (keys !== "claims,code,elapsedMs,nativeFailure,quotaDenials,quotaRequired,requests" || !failure)) || !integer(row.code, 10) || !integer(row.claims, 65535) ||
        !integer(row.requests, 65535) || !integer(row.quotaRequired, 200) || !integer(row.quotaDenials, 65535) || !integer(row.elapsedMs, 600_000)) return undefined;
    return Object.freeze({ code: row.code, claims: row.claims, requests: row.requests, quotaRequired: row.quotaRequired,
      quotaDenials: row.quotaDenials, elapsedMs: row.elapsedMs, ...(failure ? { nativeFailure: failure } : {}) });
  } catch { return undefined; }
}
const codes = ["cancelled", "uncertain", "invalidConfig", "invalidQuery", "forbidden", "unavailable", "alreadyClaimed", "mismatched", "attemptUncertain", "rateLimited"] as const;
export function financialExpiryResultCode(result: unknown): number {
  try {
    const r = result as { ok?: unknown; value?: { kind?: unknown }; error?: { kind?: unknown } };
    const kind = r?.ok === true ? r.value?.kind : r?.ok === false ? r.error?.kind : undefined;
    const index = codes.findIndex(code => code === kind); return index < 0 ? 0 : index + 1;
  } catch { return 0; }
}
/** A bounded numeric accumulator cannot provide success, permissions or effect
 * identity. Its count saturation avoids unbounded process-lifetime collection. */
export class FinancialExpiryObservations {
  #value: FinancialExpiryObservation | undefined;
  accept(message: unknown): boolean {
    try {
      if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).sort().join(",") !== "kind,observation") return false;
      const row = message as { kind: unknown; observation: unknown };
      const next = financialExpiryObservation(row.observation); if (row.kind !== "expiryObservation" || !next) return false;
      const prior = this.#value;
      const failure = prior?.nativeFailure?.afterClaim ? prior.nativeFailure : next.nativeFailure?.afterClaim ? next.nativeFailure : prior?.nativeFailure ?? next.nativeFailure;
      this.#value = Object.freeze({ ...next,
        claims: Math.min(65535, (prior?.claims ?? 0) + next.claims), requests: Math.min(65535, (prior?.requests ?? 0) + next.requests),
        quotaDenials: Math.min(65535, (prior?.quotaDenials ?? 0) + next.quotaDenials),
        quotaRequired: Math.max(prior?.quotaRequired ?? 0, next.quotaRequired), elapsedMs: Math.max(prior?.elapsedMs ?? 0, next.elapsedMs),
        ...(failure ? { nativeFailure: failure } : {}) });
      return true;
    } catch { return false; }
  }
  get value(): FinancialExpiryObservation | undefined { return this.#value; }
}
const failures = new WeakMap<Error, FinancialExpiryObservation>();
/** Preserve the first failure's exact identity/stack. Only this separate numeric
 * snapshot may cross the compiled IPC; no error is serialized or inspected here. */
export function attachFinancialExpiryObservation(error: unknown, raw: unknown): unknown {
  const observation = financialExpiryObservation(raw); if (error instanceof Error && observation) failures.set(error, observation); return error;
}
export function financialExpiryFailureObservation(error: unknown): FinancialExpiryObservation | undefined { return error instanceof Error ? failures.get(error) : undefined; }

export type FinancialExpiryProbeResult = Readonly<{ kind: "result"; passed: boolean; file: number; line: number; observation?: FinancialExpiryObservation }>;
/** Parent failure channel only. Evidence can explain a false result, never turn
 * it into a pass or smuggle an error/value through an accepted result object. */
export function financialExpiryProbeResult(value: unknown): FinancialExpiryProbeResult | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>, keys = Object.keys(row).sort().join(",");
    const observation = Object.hasOwn(row, "observation") ? financialExpiryObservation(row.observation) : undefined;
    if ((keys !== "file,kind,line,passed" && (keys !== "file,kind,line,observation,passed" || !observation || row.passed !== false)) ||
        row.kind !== "result" || typeof row.passed !== "boolean" || !integer(row.file, 3) || !integer(row.line, 4096)) return undefined;
    return Object.freeze({ kind: "result", passed: row.passed, file: row.file, line: row.line, ...(observation ? { observation } : {}) });
  } catch { return undefined; }
}
