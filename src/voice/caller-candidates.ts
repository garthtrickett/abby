import type { LocationScope, Result } from "../core/model.ts";

/** Candidate IDs are transient clues and never establish the caller's identity. */
export type CallerCandidates = Readonly<{
  kind: "noNumber" | "indexStale" | "none" | "one" | "multiple" | "tooMany";
  candidateIds: readonly string[];
}>;

export type CallerCandidateLookup = Readonly<{
  candidates(scope: Pick<LocationScope, "tenantId" | "clinicId">, presentedCallerNumber: string, signal?: AbortSignal):
    Promise<Result<CallerCandidates, Readonly<{ kind: string }>>>;
}>;

export function validCallerCandidates(value: unknown): value is CallerCandidates {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "candidateIds,kind") return false;
  if (!Array.isArray(candidate.candidateIds) || candidate.candidateIds.length > 10 ||
      candidate.candidateIds.some(id => typeof id !== "string" || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) ||
      new Set(candidate.candidateIds).size !== candidate.candidateIds.length) return false;
  const count = candidate.candidateIds.length;
  return candidate.kind === "one" ? count === 1 : candidate.kind === "multiple" ? count >= 2 :
    ["noNumber", "indexStale", "none", "tooMany"].includes(String(candidate.kind)) && count === 0;
}
