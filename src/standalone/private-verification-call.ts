import { isDeepStrictEqual } from "node:util";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { AdmissionReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";

export type PrivateVerificationCall = Readonly<{
  receipt: AdmissionReceipt; sessionId: string; policyVersion: string;
  ledger: Pick<LedgerStore, "read" | "readWriteStop">; policyStore: Pick<PolicyStore, "read">;
}>;
/** One owning admission/lease/policy check for private patient or guardian verification.
 * Caller-ID, identity, native permission and outbound context remain separate. */
export async function activePrivateVerificationCall(config: PrivateVerificationCall, writes: boolean, clock: () => string): Promise<Readonly<{ expiresAt: string }> | undefined> {
  const { receipt, sessionId, policyVersion, ledger, policyStore } = config;
  const current = await policyStore.read(receipt.scope);
  if (!current.ok || !sameScope(current.value.scope, receipt.scope) || current.value.automationEnabled !== true ||
      current.value.policyVersion !== policyVersion) return undefined;
  if (writes) {
    const stop = await ledger.readWriteStop(receipt.scope);
    if (!stop.ok || stop.value.stopped) return undefined;
  }
  // Admission/lease is read last so a close during policy/stop reads wins.
  const state = await ledger.read(receipt.callId, receipt.scope);
  if (!state.ok || state.value.callId !== receipt.callId || state.value.lifecycle !== "active" || state.value.callerIdentityDenied !== undefined ||
      !sameScope(state.value.policy.scope, receipt.scope) || state.value.policy.automationEnabled !== true || state.value.policy.policyVersion !== policyVersion ||
      !state.value.sessionLease || state.value.sessionLease.sessionId !== sessionId || Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(clock()) ||
      !state.value.admission || !isDeepStrictEqual(state.value.admission, receipt.admission)) return undefined;
  // The owner checks the deadline again after its final context/close guard.
  return { expiresAt: state.value.sessionLease.expiresAt };
}
