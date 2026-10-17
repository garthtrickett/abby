import type { LocationScope, Result } from "./model.ts";
export type OutboundEffectBarrierFailure = Readonly<{ kind: "invalidInput" | "bindingMismatch" | "storageFailure" }>;
/** Trusted opaque one-use exclusion only. Neither a fresh claim nor local
 * absence proves contact permission, native history or complete restore. */
export interface OutboundEffectBarrier {
  matches(scope: LocationScope, ownerBinding: string): boolean;
  claimOnce(effectRef: string): Promise<Result<Readonly<{ claimed: boolean }>, OutboundEffectBarrierFailure>>;
}
