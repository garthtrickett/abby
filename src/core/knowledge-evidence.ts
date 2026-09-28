import type { ModelKnowledgeContextHost, KnowledgeReadFailure } from "./host.ts";
import { err, ok } from "./model.ts";
import type { ApprovedKnowledge, CallPolicy, LocationScope, Result } from "./model.ts";

export function validKnowledgeSource(value: unknown, scope: LocationScope, now: string): value is ApprovedKnowledge {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (!source.scope || typeof source.scope !== "object") return false;
  const bound = source.scope as Record<string, unknown>;
  return bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId && bound.locationId === scope.locationId &&
    typeof source.sourceRef === "string" && !!source.sourceRef.trim() && source.sourceRef.length <= 256 &&
    typeof source.version === "string" && !!source.version.trim() && source.version.length <= 128 &&
    typeof source.ownerRef === "string" && !!source.ownerRef.trim() && source.ownerRef.length <= 256 &&
    typeof source.approvedText === "string" && !!source.approvedText.trim() && source.approvedText.length <= 2_000 &&
    source.approved === true && typeof source.effectiveFrom === "string" && typeof source.effectiveUntil === "string" &&
    Number.isFinite(Date.parse(source.effectiveFrom)) && Number.isFinite(Date.parse(source.effectiveUntil)) &&
    Date.parse(source.effectiveFrom) <= Date.parse(now) && Date.parse(now) < Date.parse(source.effectiveUntil);
}

export function validKnowledgeSnapshot(value: unknown): value is NonNullable<CallPolicy["knowledgeSnapshot"]> {
  return Array.isArray(value) && value.length <= 256 && value.every(item =>
    !!item && typeof item === "object" && typeof item.sourceRef === "string" && !!item.sourceRef.trim() && item.sourceRef.length <= 256 &&
    typeof item.version === "string" && !!item.version.trim() && item.version.length <= 128) &&
    new Set(value.map(item => item.sourceRef)).size === value.length;
}

export async function captureKnowledgeSnapshot(host: ModelKnowledgeContextHost, scope: LocationScope, now: string):
  Promise<Result<NonNullable<CallPolicy["knowledgeSnapshot"]>, KnowledgeReadFailure>> {
  if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidQuery" });
  try {
    const listed = await host.listModelKnowledge(scope, now);
    if (!listed.ok) return listed;
    if (!Array.isArray(listed.value) || listed.value.length > 256 ||
        listed.value.some(source => !validKnowledgeSource(source, scope, now))) return err({ kind: "unavailable" });
    const snapshot = listed.value.map(source => ({ sourceRef: source.sourceRef, version: source.version }));
    return validKnowledgeSnapshot(snapshot) ? ok(snapshot) : err({ kind: "unavailable" });
  } catch { return err({ kind: "unavailable" }); }
}

export function validCallKnowledgeSource(source: unknown, policy: CallPolicy, now: string): source is ApprovedKnowledge {
  if (!validKnowledgeSource(source, policy.scope, now)) return false;
  return policy.knowledgeSnapshot === undefined ||
    (validKnowledgeSnapshot(policy.knowledgeSnapshot) && policy.knowledgeSnapshot.some(item =>
      item.sourceRef === source.sourceRef && item.version === source.version));
}
