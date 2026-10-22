import { twilioNotificationCodec } from "./internal/twilio-notification-codec.ts";
import type { TwilioNotification } from "./internal/twilio-notification-codec.ts";

/** Authenticated completed notification only. No closure, whole-call opt-out,
 * patient verification, clinical permission or contact/capacity release. */
export type TwilioOutboundTerminalObservation = TwilioNotification<"completed">;
const codec = twilioNotificationCodec({ status: "completed" as const, error: "invalidTwilioTerminalObservation" as const,
  header: "Abby Twilio terminal observation v1",
  instruction: "Authenticated notification only. Not call closure, contact evidence or permission. Never replay.",
  actionDomain: "abby.twilio-terminal-purpose.v1", digestDomain: "abby.twilio-terminal-observation.v1",
  keyDomain: "abby.twilio-terminal-key.v1", authenticationDomain: "abby.twilio-terminal.authentication.v1" });

/** Stable purpose domain; configuration/key revisions never reset this action. */
export const twilioOutboundTerminalActionRef = codec.actionRef;
export const encodeTwilioOutboundTerminalObservation = codec.encode;
export const decodeTwilioOutboundTerminalObservation = codec.decode;
export const twilioOutboundTerminalObservationDigest = codec.digest;
export class TwilioOutboundTerminalObservationAuthentication extends codec.Authentication {}
