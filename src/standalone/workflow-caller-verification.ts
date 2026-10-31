import { err, ok } from "../core/model.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoRepresentativeSelection } from "./cliniko-representative-selection.ts";
import { ClinikoGuardianSelection } from "./cliniko-guardian-selection.ts";
import type { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";

export type RepresentativeWorkflowSelection = Readonly<{ owner: ClinikoRepresentativeSelection | ClinikoGuardianSelection; selectionRef: string }>;
export const isRepresentativeSelection = (owner: unknown): owner is RepresentativeWorkflowSelection["owner"] =>
  owner instanceof ClinikoRepresentativeSelection || owner instanceof ClinikoGuardianSelection &&
    Object.getPrototypeOf(owner) === ClinikoGuardianSelection.prototype && owner.matchesWorkflow === ClinikoGuardianSelection.prototype.matchesWorkflow &&
    owner.verifier === ClinikoGuardianSelection.prototype.verifier;
type Config = Parameters<typeof CallerVerificationSession.create>[0];
type NativeBinding = Readonly<{ credentialFingerprint: string; businessId: string; timeZone: string }>;

/** Trusted workflow composition. A delegated verifier adds authority checks;
 * it retains the workflow's own current method/policy and patient permission. */
export async function createWorkflowCallerVerification(config: Config, binding: NativeBinding, signal: AbortSignal,
  caller: OwnerFileCallerPolicy, representative?: RepresentativeWorkflowSelection): Promise<ReturnType<typeof CallerVerificationSession.create>> {
  representative = representative ? Object.freeze({ ...representative }) : undefined;
  if (signal.aborted) return err({ kind: "verificationUnavailable" });
  if (!representative) return CallerVerificationSession.create(config);
  if (!isRepresentativeSelection(representative.owner) || !representative.owner.matchesWorkflow({ ...binding,
      scope: config.receipt.scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
      operation: config.operation, selectionRef: representative.selectionRef, inbound: config.inbound }) || !await caller.allowsRepresentative(config.receipt.scope) || signal.aborted) {
    return err({ kind: "verificationUnavailable" });
  }
  const policy = { operation: config.operation, current: async (scope: typeof config.receipt.scope) => {
    const found = await config.policy.current(scope);
    return found.ok ? ok({ ...found.value, enabled: found.value.enabled && await caller.allowsRepresentative(scope) }) : found;
  } };
  const found = await representative.owner.verifier(representative.selectionRef, signal, { policy, permission: config.permission });
  return found.ok ? found : err({ kind: "verificationUnavailable" });
}
