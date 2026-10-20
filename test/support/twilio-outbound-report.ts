import { randomUUID } from "node:crypto";
import { TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { outboundContactOutcomeValue } from "./outbound-contact-outcome.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { value } from "./outbound-records.ts";

export function twilioOutboundReportValue(stopped = false, options: Readonly<{
  credentialFingerprint?: string; scope?: LocationScope; patientId?: string; Authentication?: typeof TwilioOutboundReportAuthentication;
  key?: Uint8Array;
}> = {}) {
  const { possible, outcome } = outboundContactOutcomeValue(options.credentialFingerprint), a = { ...possible.attempt,
    ...(options.scope ? { scope: options.scope } : {}), ...(options.patientId ? { patientId: options.patientId } : {}) };
  const original = { ...outcome.attempt, digest: outboundLaunchAttemptDigest(a)! };
  const context = { original: { recallRef: possible.recallRef, attempt: a }, attemptDigest: original.digest,
    number: "+12025550123", reportActionRef: randomUUID(), sessionActionRef: randomUUID() };
  const key = Buffer.from(options.key ?? Buffer.alloc(32, 17)), auth = new (options.Authentication ?? TwilioOutboundReportAuthentication)(key, a.provider);
  const unsigned: Omit<TwilioOutboundReport, "authentication"> = { actionRef: context.reportActionRef, scope: a.scope,
    businessId: a.businessId, credentialFingerprint: a.credentialFingerprint, patientId: a.patientId, original,
    accountSid: "AC" + "1".repeat(32), callSid: "CA" + "2".repeat(32), number: context.number, terminal: outcome.terminal,
    contact: stopped ? { kind: "stopRequested", stoppedAt: "2026-11-01T10:01:00.000Z" } : { kind: "completeNoStop" },
    reportedAt: "2026-11-01T10:03:00.000Z", recordedAt: outcome.recordedAt };
  return { auth, context, key, unsigned, report: value(auth.sign(unsigned)) };
}
