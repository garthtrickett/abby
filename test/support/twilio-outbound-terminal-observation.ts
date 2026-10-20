import { TwilioOutboundTerminalObservationAuthentication, twilioOutboundTerminalActionRef } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservation } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { twilioOutboundReportValue } from "./twilio-outbound-report.ts";
import { value } from "./outbound-records.ts";

type Options = Pick<NonNullable<Parameters<typeof twilioOutboundReportValue>[1]>, "credentialFingerprint" | "scope" | "patientId" | "key">;
/** Synthetic source value only. No real callback, closure or native write is
 * proved by this fixture; the actual producer/recovery needs separate tests. */
export function twilioOutboundTerminalObservationValue(options: Options = {}) {
  const prior = twilioOutboundReportValue(true, options), context = { ...prior.context, sessionActionRef: "11111111-1111-4111-8111-111111111111" };
  const { terminal: _terminal, contact: _contact, reportedAt, ...base } = prior.unsigned;
  const unsigned: Omit<TwilioOutboundTerminalObservation, "authentication"> = { ...base,
    actionRef: twilioOutboundTerminalActionRef(context.sessionActionRef)!, sessionActionRef: context.sessionActionRef,
    status: "completed", receivedAt: reportedAt };
  const auth = new TwilioOutboundTerminalObservationAuthentication(prior.key, prior.auth.binding()), observation = value(auth.sign(unsigned));
  return { prior, context, unsigned, observation, auth, key: prior.key };
}
