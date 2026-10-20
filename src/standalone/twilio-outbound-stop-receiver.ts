import { TwilioOutboundIngress } from "../voice/twilio-outbound-ingress.ts";
import type { TwilioOutboundIngressConfig } from "../voice/twilio-outbound-ingress.ts";
import { ClinikoTwilioOutboundStopRecovery } from "./cliniko-twilio-outbound-stop-recovery.ts";

/** Optional actual signed receiver composition, with the router's existing
 * deadline/current grants and no detached job or private local retry queue.
 * The callback triggers an independently authenticated NATIVE report read; its
 * status never supplies stop, patient or complete terminal/contact truth. */
export function twilioOutboundStopReceiver(config: Omit<TwilioOutboundIngressConfig, "receiveAuthenticatedStatus"> & Readonly<{
  stopRecovery: ClinikoTwilioOutboundStopRecovery;
}>): TwilioOutboundIngress {
  if (!(config.stopRecovery instanceof ClinikoTwilioOutboundStopRecovery) || !config.stopRecovery.matchesRuntime(config.runtime))
    throw Error("Invalid outbound stop receiver selection");
  const recover = config.stopRecovery.recoverStatusEvidence.bind(config.stopRecovery), matches = config.stopRecovery.matchesRuntime.bind(config.stopRecovery);
  const runtime = config.runtime;
  return new TwilioOutboundIngress({ ...config, receiveAuthenticatedStatus: async (request, event, signal) => {
    if (!matches(runtime)) throw Error("Unavailable outbound stop recovery");
    if (!["completed", "busy", "failed", "no-answer", "canceled"].includes(event.status)) {
      return;
    }
    const result = await recover(request, signal);
    // A negative status/absence is not a contact grant. A lost native ACK may
    // be discovered by the next signed delivery; an unobserved write cannot
    // replay because its permanent one-use action remains consumed.
    if (!result.ok || result.value.evidence === "missing" || result.value.outcome.kind === "uncertain" || !matches(runtime))
      throw Error("Unresolved outbound stop recovery");
  } });
}
