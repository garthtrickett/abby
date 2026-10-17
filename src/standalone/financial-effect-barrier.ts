import type { Result } from "../core/model.ts";

export type FinancialEffectBarrierFailure = Readonly<{ kind: "invalidInput" | "bindingMismatch" | "storageFailure" }>;
/** Trusted financial owner only. A fresh claim permanently burns an opaque ID
 * BEFORE any external effect. False/unknown/timeout never permits submission.
 * This is not pending-work storage, payment truth, financial/clinical permission,
 * producer admission, or proof that a restored database contains all history. */
export interface FinancialEffectBarrier {
  claimOnce(effectRef: string): Promise<Result<Readonly<{ claimed: boolean }>, FinancialEffectBarrierFailure>>;
}
export const validFinancialEffectRef = (v: unknown): v is string => typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
