import { createHash } from "node:crypto";
import type { LocationScope, Result } from "./model.ts";
import { validOutboundEffectRef } from "./outbound-effect-barrier.ts";

export type OutboundCapacityFailure = Readonly<{ kind: "invalidInput" | "bindingMismatch" | "storageFailure" | "forbidden" }>;
/** Opaque occupancy only. A fresh allocation is not permission to dial. Unknown
 * submission/process loss keeps occupancy; expiry/heartbeat/PID is not terminal.
 * Only the trusted owning launch protocol may release after proving no dispatch
 * or current exact provider terminal evidence. No public release route exists. */
export interface OutboundCapacity {
  matches(scope: LocationScope, ownerBinding: string): boolean;
  acquireOnce(allocationRef: string, maximum: number): Promise<Result<Readonly<{ kind: "acquired" | "full" | "alreadyUsed" }>, OutboundCapacityFailure>>;
  releaseOnce(allocationRef: string, beforeRelease?: () => boolean): Promise<Result<Readonly<{ released: boolean }>, OutboundCapacityFailure>>;
}
/** Stable across policy/provider revisions and scope remapping: old possibly
 * live allocations must still count for this independently random campaign.
 * Tenant/location ownership is checked separately, never supplied by this hash. */
export function outboundCapacityOwnerBinding(campaignRef: string): string | undefined {
  return validOutboundEffectRef(campaignRef) ? createHash("sha256").update(JSON.stringify(["abby.outbound-capacity.v1", campaignRef])).digest("hex") : undefined;
}
