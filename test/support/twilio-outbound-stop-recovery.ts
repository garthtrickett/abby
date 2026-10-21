import { randomBytes, randomUUID } from "node:crypto";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { outboundStopOwnerFixture } from "./outbound-stop-owner.ts";
import { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import { value } from "./outbound-records.ts";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { TwilioOutboundContext } from "../../src/voice/twilio-outbound-context.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { encodeTwilioOutboundReport, TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import type { TwilioOutboundReportHistoryQuery } from "../../src/cliniko/twilio-outbound-report-history.ts";
import type { TwilioOutboundReportQuery } from "../../src/cliniko/twilio-outbound-report-records.ts";
import { ClinikoTwilioOutboundStopRecovery } from "../../src/standalone/cliniko-twilio-outbound-stop-recovery.ts";
import type { OutboundRecordConfig } from "../../src/cliniko/outbound-recipient-records.ts";

export async function twilioOutboundStopRecoveryFixture(options: Parameters<typeof outboundStopOwnerFixture>[0] & {
  profileRef?: (requests: OutboundRecordConfig) => string;
  recoveryRuntime?: { ClinikoTwilioOutboundStopRecovery: typeof ClinikoTwilioOutboundStopRecovery;
    TwilioAbbyOutboundRuntime: typeof TwilioAbbyOutboundRuntime; TwilioOutboundReportAuthentication: typeof TwilioOutboundReportAuthentication };
} = {}) {
  const { recoveryRuntime = { ClinikoTwilioOutboundStopRecovery, TwilioAbbyOutboundRuntime, TwilioOutboundReportAuthentication }, profileRef, ...stopOptions } = options;
  let now = "2026-11-02T00:00:00.000Z";
  const carrier = { ref: "synthetic-provider", profileRef: "generic-clinic-greeting", accountSid: "AC" + "a".repeat(32),
    authToken: `synthetic-stop-recovery-secret-${randomUUID()}`, from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer",
    publicStatusUrl: "https://clinic.example.invalid/outbound/status", publicStreamUrl: "wss://clinic.example.invalid/outbound/stream",
    contextKey: randomBytes(32), now: () => now };
  let runtime!: TwilioAbbyOutboundRuntime;
  const LaunchFixture = async (input: Parameters<typeof outboundLaunchOwnerFixture>[0]) => {
    const f = await outboundLaunchOwnerFixture(input);
    if (profileRef) carrier.profileRef = profileRef(f.config.requests);
    runtime = new recoveryRuntime.TwilioAbbyOutboundRuntime(carrier, async () => { throw Error("Recovery must never launch a carrier request"); });
    f.controls.providerDigest = runtime.binding().bindingDigest; return f;
  };
  const f = await outboundStopOwnerFixture({ ...stopOptions, LaunchFixture });
  try {
    const contextCodec = new TwilioOutboundContext(carrier.contextKey, runtime.binding(), carrier.accountSid, carrier.from);
    const call = { effectRef: f.attempt.effectRef, capacityAllocationRef: f.attempt.capacityAllocationRef!,
      number: f.request.recipient.number, profileRef: carrier.profileRef };
    const original = { recallRef: f.stopBinding.recallRef, attempt: f.attempt }, reportActionRef = randomUUID(), sessionActionRef = randomUUID();
    const context = { original, attemptDigest: outboundLaunchAttemptDigest(f.attempt)!, number: call.number, reportActionRef, sessionActionRef };
    const token = contextCodec.sealLaunch(original, call, reportActionRef, sessionActionRef), url = new URL(carrier.publicStatusUrl);
    url.searchParams.set("abbyContext", token);
    const callSid = "CA" + "b".repeat(32);
    const request = (patch: Record<string, string> = {}) => {
      now = f.state.now;
      const fields = { AccountSid: carrier.accountSid, CallSid: callSid, From: carrier.from, To: call.number,
        Direction: "outbound-api", CallStatus: "completed", ...patch };
      return { method: "POST", requestTarget: url.pathname + url.search, contentType: "application/x-www-form-urlencoded",
        signature: getExpectedTwilioSignature(carrier.authToken, url.href, fields), body: new URLSearchParams(fields).toString() };
    };
    const key = randomBytes(32), auth = new recoveryRuntime.TwilioOutboundReportAuthentication(key, f.attempt.provider);
    const unsigned: Omit<TwilioOutboundReport, "authentication"> = { actionRef: reportActionRef, scope: f.attempt.scope, businessId: f.attempt.businessId,
      credentialFingerprint: f.attempt.credentialFingerprint, patientId: f.attempt.patientId,
      original: { recallRef: original.recallRef, actionRef: f.attempt.actionRef, digest: context.attemptDigest }, accountSid: carrier.accountSid,
      callSid, number: call.number, terminal: null, contact: { kind: "stopRequested", stoppedAt: f.state.now }, reportedAt: f.state.now, recordedAt: f.state.now };
    const report = value(auth.sign(unsigned)), reportRow: Record<string, unknown> & { id: string; notes: string } = { ...f.row, id: "250", notes: value(encodeTwilioOutboundReport(report)),
      links: { self: "https://api.au5.cliniko.com/v1/recalls/250" }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/64" } } };
    f.contactControls.rows.push(reportRow);
    const state = { live: true, broad: true, decoded: true, allowed: true };
    const queries: (TwilioOutboundReportQuery | TwilioOutboundReportHistoryQuery)[] = [];
    const config = { stop: f.stopConfig, reports: { ...f.config.requests, outboundProviderReportRecallTypeId: "64", providerReportPolicyDigest: "b".repeat(64) } };
    const ports = { ...f.stopPorts, runtime, authentication: auth, reports: {
      allowsHistoryRead: async (q: TwilioOutboundReportHistoryQuery) => { queries.push(q); return state.broad && state.allowed; },
      allowsRecordRead: async (q: TwilioOutboundReportQuery) => { queries.push(q); return state.allowed && (!q.report || state.decoded); },
      current: () => state.live } };
    const make = () => recoveryRuntime.ClinikoTwilioOutboundStopRecovery.create(config, ports);
    const recover = (signal = new AbortController().signal) => value(make()).recoverStatus(request(), signal);
    return { ...f, get claims() { return f.claims; }, key, recoveryConfig: config, recoveryPorts: ports, reportState: state, reportQueries: queries, reportRow, report, unsigned, auth,
      context, carrier, callSid, request, makeRecovery: make, recover,
      replaceReport: (patch: Partial<Omit<TwilioOutboundReport, "authentication">>) => { reportRow.notes = value(encodeTwilioOutboundReport(value(auth.sign({ ...unsigned, ...patch })))); } };
  } catch (e) { await f.close(); throw e; }
}
