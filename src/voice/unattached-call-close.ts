import { err } from "../core/model.ts";
import type { AdmissionReceipt, CallState, PendingLocationCall, Result, TransitionFailure } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { CallRuntime } from "../core/runtime.ts";
import type { AuthenticatedInboundCall } from "./admission.ts";
import type { SharedNumberIntakeService } from "./shared-number-intake.ts";

/** Retires an admitted reservation after provider binding fails or a disconnect wins; opens no provider. */
export async function closeUnattachedCall(config: Readonly<{
  ledger: LedgerStore; intake: SharedNumberIntakeService; event: AuthenticatedInboundCall;
  receipt?: AdmissionReceipt; sessionId: string; now: string; reason: "callerDisconnected" | "sessionClosed";
}>): Promise<Result<CallState | PendingLocationCall, TransitionFailure>> {
  const { ledger, intake, event, receipt, sessionId, now, reason } = config;
  if (receipt) {
    const runtime = new CallRuntime(ledger, receipt.scope);
    const current = await runtime.read(receipt.callId);
    if (!current.ok) return current;
    if (current.value.lifecycle === "starting") {
      const activated = await runtime.activate(receipt.callId, sessionId, now);
      if (!activated.ok) return activated;
    }
    // endCall checks the session owner; a failed duplicate must never close someone else's active call.
    return runtime.endCall(receipt.callId, sessionId, now, reason);
  }
  const attached = await intake.attachSession(event, sessionId);
  if (!attached.ok) return attached;
  const lease = attached.value.sessionLease;
  if (!lease || lease.sessionId !== sessionId) return err({ kind: "leaseLost" });
  return ledger.closePendingLocationSession(attached.value.callId, sessionId, lease.version, reason, now);
}
