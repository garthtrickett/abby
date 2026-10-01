import { createHash } from "node:crypto";
import { err, ok } from "./model.ts";
import type { Admission, CallPolicy, PendingLocationCall, PendingLocationPrompt, PendingLocationRoute, Result, TransitionFailure } from "./model.ts";

export const LOCATION_CHOICE_TIMEOUT_MS = 120_000;
export const PENDING_LOCATION_LEASE_MS = 30_000;

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

export function normalizedSpokenName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
  return normalized && /^[\p{L}\p{N}](?:[\p{L}\p{N} .,'&-]*[\p{L}\p{N}])?$/u.test(normalized) ? normalized : undefined;
}

export function validCandidateNames(ids: readonly string[], names: unknown): boolean {
  if (!Array.isArray(names) || names.length !== ids.length) return false;
  const normalized = new Set<string>();
  return names.every((item, index) => {
    const name = item && typeof item === "object" ? item as { locationId?: unknown; spokenName?: unknown } : undefined;
    const key = normalizedSpokenName(name?.spokenName);
    if (name?.locationId !== ids[index] || !key || normalized.has(key)) return false;
    normalized.add(key);
    return true;
  });
}

export function validPendingRoute(route: unknown): route is PendingLocationRoute {
  if (!route || typeof route !== "object") return false;
  const value = route as Partial<PendingLocationRoute>;
  return validRef(value.tenantId) && validRef(value.clinicId) && validRef(value.routeVersion) &&
    Array.isArray(value.candidateLocationIds) && value.candidateLocationIds.length >= 2 &&
    value.candidateLocationIds.length <= 32 && value.candidateLocationIds.every(validRef) &&
    new Set(value.candidateLocationIds).size === value.candidateLocationIds.length &&
    validCandidateNames(value.candidateLocationIds, value.candidateNames);
}

export function pendingCallId(key: Admission["key"]): string {
  return createHash("sha256").update(JSON.stringify([key.accountRef, key.providerCallRef])).digest("hex");
}

export function validPendingAdmission(callId: string, admission: unknown): admission is Admission {
  if (!admission || typeof admission !== "object") return false;
  const value = admission as Partial<Admission>;
  return !!value.key && validRef(value.key.accountRef) && validRef(value.key.providerCallRef) &&
    pendingCallId(value.key) === callId && validRef(value.dialedNumber) &&
    typeof value.acceptedAt === "string" && Number.isFinite(Date.parse(value.acceptedAt)) &&
    typeof value.deadline === "string" && Number.isFinite(Date.parse(value.deadline)) &&
    Date.parse(value.deadline) > Date.parse(value.acceptedAt);
}

export function validPendingLocation(value: unknown, callId: string): value is PendingLocationCall {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingLocationCall>;
  const lease = pending.sessionLease;
  const evidence = pending.choiceEvidence;
  const prompt = pending.prompt;
  const close = pending.closeEvidence;
  return pending.callId === callId && validPendingRoute(pending.route) &&
    validPendingAdmission(callId, pending.admission) &&
    (pending.status === "pending" || pending.status === "expired" || pending.status === "bound") &&
    (lease === undefined || (validRef(lease.sessionId) && Number.isSafeInteger(lease.version) && lease.version >= 1 &&
      typeof lease.expiresAt === "string" && Number.isFinite(Date.parse(lease.expiresAt)) &&
      typeof lease.validForMs === "number" && lease.validForMs > 0 && lease.validForMs <= PENDING_LOCATION_LEASE_MS)) &&
    (prompt === undefined || (lease !== undefined && validRef(prompt.playbackId) && validRef(prompt.sessionId) &&
      prompt.sessionId === lease.sessionId && prompt.leaseVersion <= lease.version &&
      Number.isSafeInteger(prompt.leaseVersion) && prompt.leaseVersion >= 1 &&
      ["started", "queued", "played", "failed", "unproven", "interrupted"].includes(prompt.status) &&
      typeof prompt.startedAt === "string" && Number.isFinite(Date.parse(prompt.startedAt)) &&
      Date.parse(prompt.startedAt) >= Date.parse(pending.admission.acceptedAt) &&
      Date.parse(prompt.startedAt) < Date.parse(pending.admission.deadline) &&
      (prompt.status === "started" || prompt.status === "queued"
        ? prompt.resolvedAt === undefined
        : typeof prompt.resolvedAt === "string" && Number.isFinite(Date.parse(prompt.resolvedAt)) &&
          Date.parse(prompt.resolvedAt) >= Date.parse(prompt.startedAt)))) &&
    (close === undefined || (pending.status === "expired" && lease !== undefined &&
      validRef(close.sessionId) && close.sessionId === lease.sessionId &&
      Number.isSafeInteger(close.leaseVersion) && close.leaseVersion === lease.version &&
      ["callerDisconnected", "sessionClosed", "mediaFailure"].includes(close.reason) &&
      typeof close.at === "string" && Number.isFinite(Date.parse(close.at)))) &&
    (evidence === undefined || (validRef(evidence.sessionId) && Number.isSafeInteger(evidence.leaseVersion) &&
      evidence.leaseVersion >= 1 && validRef(evidence.turnId) &&
      validRef(evidence.selectedLocationId) && typeof evidence.at === "string" && Number.isFinite(Date.parse(evidence.at))));
}

export function expiredPendingLocationState(pending: PendingLocationCall, now: string,
                                            closeEvidence?: PendingLocationCall["closeEvidence"]): PendingLocationCall {
  const prompt = pending.prompt;
  return { ...pending, status: "expired", ...(closeEvidence ? { closeEvidence } : {}),
    ...(prompt && (prompt.status === "started" || prompt.status === "queued")
      ? { prompt: { ...prompt, status: "unproven" as const, resolvedAt: now } } : {}) };
}

export function closePendingLocationState(pending: PendingLocationCall, sessionId: string, version: number,
                                          reason: NonNullable<PendingLocationCall["closeEvidence"]>["reason"], now: string):
  Result<PendingLocationCall, TransitionFailure> {
  if (!validRef(sessionId) || !Number.isSafeInteger(version) || version < 1 ||
      !["callerDisconnected", "sessionClosed", "mediaFailure"].includes(reason) ||
      !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
  if (pending.status === "expired" && pending.closeEvidence?.sessionId === sessionId &&
      pending.closeEvidence.leaseVersion === version && pending.closeEvidence.reason === reason) return ok(pending);
  if (pending.status === "expired") return err({ kind: "admissionExpired" });
  if (pending.status !== "pending") return err({ kind: "callConflict" });
  if (!pending.sessionLease || pending.sessionLease.sessionId !== sessionId ||
      pending.sessionLease.version !== version) return err({ kind: "leaseLost" });
  return ok(expiredPendingLocationState(pending, now, { sessionId, leaseVersion: version, reason, at: now }));
}

function ownsPendingSession(pending: PendingLocationCall, sessionId: string, version: number, now: string): boolean {
  return pending.status === "pending" && pending.sessionLease?.sessionId === sessionId &&
    pending.sessionLease.version === version && Date.parse(now) < pendingDueAt(pending);
}

export function startLocationPrompt(pending: PendingLocationCall, playbackId: string, sessionId: string,
                                    version: number, now: string, afterPlayed = false): Result<Readonly<{ pending: PendingLocationCall; newStart: boolean }>, TransitionFailure> {
  if (!validRef(playbackId) || !validRef(sessionId) || !Number.isSafeInteger(version) || version < 1 ||
      !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
  if (!ownsPendingSession(pending, sessionId, version, now)) return err({ kind: "leaseLost" });
  const previous = pending.prompt;
  if (previous?.playbackId === playbackId) return ok({ pending, newStart: false });
  if (previous && previous.status !== "failed" && !(previous.status === "played" && afterPlayed === true)) {
    return ok({ pending, newStart: false });
  }
  const prompt: PendingLocationPrompt = { playbackId, sessionId, leaseVersion: version, status: "started", startedAt: now };
  return ok({ pending: { ...pending, prompt }, newStart: true });
}

export function resolveLocationPrompt(pending: PendingLocationCall, playbackId: string, sessionId: string,
                                      version: number, status: PendingLocationPrompt["status"], now: string):
  Result<PendingLocationCall, TransitionFailure> {
  if (!validRef(playbackId) || !validRef(sessionId) || !Number.isSafeInteger(version) || version < 1 ||
      !Number.isFinite(Date.parse(now)) || !["queued", "played", "failed", "unproven", "interrupted"].includes(status)) {
    return err({ kind: "invalidTransition" });
  }
  if (!ownsPendingSession(pending, sessionId, version, now)) return err({ kind: "leaseLost" });
  const prompt = pending.prompt;
  if (!prompt || prompt.playbackId !== playbackId || prompt.sessionId !== sessionId) return err({ kind: "keyMismatch" });
  if (prompt.status === status) return ok(pending);
  if (prompt.status !== "started" && prompt.status !== "queued") return err({ kind: "keyMismatch" });
  if (prompt.status === "queued" && status === "queued") return ok(pending);
  return ok({ ...pending, prompt: { ...prompt, status, ...(status === "queued" ? {} : { resolvedAt: now }) } });
}

export function pendingDueAt(pending: PendingLocationCall): number {
  return Math.min(Date.parse(pending.admission.deadline),
    pending.sessionLease ? Date.parse(pending.sessionLease.expiresAt) : Number.POSITIVE_INFINITY);
}

export function pendingMatchesAdmission(pending: PendingLocationCall, admission: Admission): boolean {
  return pending.admission.key.accountRef === admission.key.accountRef &&
    pending.admission.key.providerCallRef === admission.key.providerCallRef &&
    pending.admission.dialedNumber === admission.dialedNumber;
}

export function policyMatchesPending(pending: PendingLocationCall, policy: CallPolicy): boolean {
  return policy.scope.tenantId === pending.route.tenantId && policy.scope.clinicId === pending.route.clinicId &&
    pending.route.candidateLocationIds.includes(policy.scope.locationId) &&
    policy.numberRouteVersion === pending.route.routeVersion;
}
