import { twilioNotificationCodec } from "./internal/twilio-notification-codec.ts";
import type { TwilioNotification } from "./internal/twilio-notification-codec.ts";

/** Authenticated no-answer notification only. No closure, whole-call opt-out,
 * patient verification, clinical permission or contact/capacity release. */
export type TwilioOutboundUnansweredObservation = TwilioNotification<"no-answer">;
const codec = twilioNotificationCodec({ status: "no-answer" as const, error: "invalidTwilioUnansweredObservation" as const,
  header: "Abby Twilio unanswered observation v1",
  instruction: "Authenticated notification only. Not call closure, contact evidence or permission. Never replay.",
  actionDomain: "abby.twilio-unanswered-purpose.v1", digestDomain: "abby.twilio-unanswered-observation.v1",
  keyDomain: "abby.twilio-unanswered-key.v1", authenticationDomain: "abby.twilio-unanswered.authentication.v1" });

/** Stable purpose domain; configuration/key revisions never reset this action. */
export const twilioOutboundUnansweredActionRef = codec.actionRef;
export const encodeTwilioOutboundUnansweredObservation = codec.encode;
export const decodeTwilioOutboundUnansweredObservation = codec.decode;
export const twilioOutboundUnansweredObservationDigest = codec.digest;
export class TwilioOutboundUnansweredObservationAuthentication extends codec.Authentication {}
