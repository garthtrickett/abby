import { err } from "./model.ts";
import type { CallPolicy, LocationScope, Result } from "./model.ts";
import type { ReadinessFailure } from "./readiness.ts";

/** Current host evidence for a public routing reference, never a staff task owner or phone number. */
export type StaffedDestinationEvidence = Readonly<{
  scope: LocationScope;
  destinationRef: string;
  hostVersion: string;
  mode: "execute" | "requestOnly";
  ready: true;
}>;

/** The embedding host validates its own route registry and permissions for this exact location. */
export type StaffedDestinationHost = (scope: LocationScope, destinationRef: string) =>
  Promise<Result<StaffedDestinationEvidence, ReadinessFailure>>;

function unready(): Result<never, ReadinessFailure> {
  return err({ kind: "readinessFailed", missing: ["staffDestination"] });
}

export const unprovenStaffedDestination: StaffedDestinationHost = async () => unready();

export function validStaffedDestinationRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function validStaffedDestinationScope(scope: LocationScope): boolean {
  return !!scope && [scope.tenantId, scope.clinicId, scope.locationId].every(value =>
    typeof value === "string" && value.length > 0);
}

export function validStaffedDestinationChange(scope: LocationScope, expectedVersion: string,
                                             destinationRef: string | null, actorRef: string): boolean {
  return validStaffedDestinationScope(scope) && typeof expectedVersion === "string" &&
    /^(0|[1-9]\d*)$/.test(expectedVersion) && Number.isSafeInteger(Number(expectedVersion)) &&
    Number(expectedVersion) < Number.MAX_SAFE_INTEGER &&
    (destinationRef === null || validStaffedDestinationRef(destinationRef)) && validStaffedDestinationRef(actorRef);
}

function validEvidence(value: unknown, scope: LocationScope, destinationRef: string): value is StaffedDestinationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const bound = row.scope as Record<string, unknown> | undefined;
  return Object.keys(row).sort().join(",") === "destinationRef,hostVersion,mode,ready,scope" &&
    !!bound && typeof bound === "object" && !Array.isArray(bound) &&
    Object.keys(bound).sort().join(",") === "clinicId,locationId,tenantId" &&
    bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId && bound.locationId === scope.locationId &&
    row.destinationRef === destinationRef && validStaffedDestinationRef(row.hostVersion) &&
    (row.mode === "execute" || row.mode === "requestOnly") && row.ready === true;
}

/** Runtime validation protects the boundary even when an adapter returns malformed JSON or throws. */
export async function resolveStaffedDestination(host: StaffedDestinationHost, scope: LocationScope,
                                               destinationRef: string): Promise<Result<StaffedDestinationEvidence, ReadinessFailure>> {
  if (!validStaffedDestinationScope(scope) || !validStaffedDestinationRef(destinationRef)) return unready();
  try {
    const bound = structuredClone(scope);
    const result = await host(structuredClone(bound), destinationRef);
    if (!result.ok || !validEvidence(result.value, bound, destinationRef)) return unready();
    return { ok: true, value: structuredClone(result.value) };
  } catch {
    return unready();
  }
}

/** One admission snapshot captures the host decision; a saved reference cannot grant execute mode. */
export async function captureStaffedDestination(policy: CallPolicy, host: StaffedDestinationHost): Promise<CallPolicy> {
  const { transferDestinationVersion: staleVersion, ...snapshot } = structuredClone(policy);
  void staleVersion;
  const fallback = snapshot.capabilities.transfer === "requestOnly" ? "requestOnly" : "unavailable";
  const evidence = snapshot.transferDestinationRef === undefined ? unready() :
    await resolveStaffedDestination(host, snapshot.scope, snapshot.transferDestinationRef);
  return { ...snapshot, capabilities: { ...snapshot.capabilities, transfer: evidence.ok ? evidence.value.mode : fallback },
    ...(evidence.ok ? { transferDestinationVersion: evidence.value.hostVersion } : {}) };
}

export type StaffedDestinationAuditEntry = Readonly<{
  version: string;
  destinationRef: string | null;
  previousDestinationRef: string | null;
  actorRef: string;
  changedAt: string;
}>;
export type StaffedDestinationAuditPage = Readonly<{
  entries: readonly StaffedDestinationAuditEntry[];
  nextAfterVersion?: number;
}>;
