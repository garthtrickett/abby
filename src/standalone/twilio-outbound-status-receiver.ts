import { TwilioOutboundIngress } from "../voice/twilio-outbound-ingress.ts";
import type { TwilioOutboundIngressConfig } from "../voice/twilio-outbound-ingress.ts";
import { TwilioOutboundStatusDelivery } from "./twilio-outbound-status-delivery.ts";

/** Explicit optional signed callback. HTTP204 acknowledges retained delivery;
 * stop recovery keeps its independent grants and neither hold is released. */
export function twilioOutboundStatusReceiver(config: Omit<TwilioOutboundIngressConfig, "receiveAuthenticatedStatus"> & Readonly<{
  delivery: TwilioOutboundStatusDelivery;
}>): TwilioOutboundIngress {
  if (!(config.delivery instanceof TwilioOutboundStatusDelivery) || !config.delivery.matchesRuntime(config.runtime))
    throw Error("Invalid outbound status receiver selection");
  const receive = config.delivery.receiveStatus.bind(config.delivery), matches = config.delivery.matchesRuntime.bind(config.delivery), runtime = config.runtime;
  return new TwilioOutboundIngress({ ...config, receiveAuthenticatedStatus: async (request, _event, signal) => {
    if (!matches(runtime)) throw Error("Unavailable outbound status receiver");
    const result = await receive(request, signal);
    if (!result.ok || !matches(runtime)) throw Error("Unresolved outbound status delivery");
  } });
}
