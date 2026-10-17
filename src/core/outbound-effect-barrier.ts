import type { LocationScope, Result } from "./model.ts";
export type OutboundEffectBarrierFailure = Readonly<{ kind: "invalidInput" | "bindingMismatch" | "storageFailure" }>;
/** Trusted opaque one-use exclusion only. Neither a fresh claim nor local
 * absence proves contact permission, native history or complete restore. */
export interface OutboundEffectBarrier {
  matches(scope: LocationScope, ownerBinding: string): boolean;
  claimOnce(effectRef: string): Promise<Result<Readonly<{ claimed: boolean }>, OutboundEffectBarrierFailure>>;
}

export const validOutboundEffectRef = (v: unknown): v is string => typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
