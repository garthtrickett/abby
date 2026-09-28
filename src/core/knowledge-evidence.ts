import type { ApprovedKnowledge, LocationScope } from "./model.ts";

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
