import assert from "node:assert/strict";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { randomUUID } from "node:crypto";
import { ClinikoIncomingCallContext } from "../../src/standalone/cliniko-incoming-call-context.ts";
import type { IncomingCallContextAuthority } from "../../src/standalone/cliniko-incoming-call-context.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { OwnerFileCallerPolicy } from "../../src/standalone/owner-file-caller-policy.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { TwilioOutboundTerminalObservationAuthentication, encodeTwilioOutboundTerminalObservation, twilioOutboundTerminalActionRef } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { TwilioOutboundUnansweredObservationAuthentication, encodeTwilioOutboundUnansweredObservation, twilioOutboundUnansweredActionRef } from "../../src/cliniko/twilio-outbound-unanswered-observation.ts";
import { outboundRecordsFixture, value } from "./outbound-records.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { outboundTargetFixture } from "./outbound-appointment-target.ts";
import { callerVerificationFixture } from "./caller-verification.ts";

export async function incomingCallContextFixture(options: { sickDay?: boolean; patientId?: string; campaignPatientId?: string; budget?: ClinikoRequestBudget; nativeRequestCosts?: boolean } = {}) {
  const target = outboundTargetFixture({ apiKey: "synthetic-outbound-au5", ...(options.campaignPatientId ? { patientId: options.campaignPatientId } : {}) });
  const observed = value(await target.observe());
  const request = { ...outboundRequestValue(), ...(options.campaignPatientId ? { patientId: options.campaignPatientId } : {}), ...(options.sickDay ? { purpose: "sickDay" as const,
    appointment: { ref: observed.target.appointmentRef, digest: observed.digest } } : {}) };
  const native = await outboundRecordsFixture({ request, ...(options.budget ? { budget: options.budget } : {}) }); value(await native.retain());
  const now = "2026-11-01T10:05:00.000Z"; native.setNow(now);
  const attempt = { ...outboundLaunchValue(native.request).attempt, capacityAllocationRef: randomUUID() };
  const auth = new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 29), attempt.provider);
  const sessionActionRef = randomUUID(), accountSid = "AC" + "1".repeat(32);
  const unsigned = { actionRef: twilioOutboundTerminalActionRef(sessionActionRef)!, scope: attempt.scope, businessId: attempt.businessId,
    credentialFingerprint: attempt.credentialFingerprint, patientId: attempt.patientId,
    original: { recallRef: "cliniko:recall:40", actionRef: attempt.actionRef, digest: outboundLaunchAttemptDigest(attempt)! },
    accountSid, callSid: "CA" + "2".repeat(32), number: native.request.recipient.number, sessionActionRef,
    status: "completed" as const, receivedAt: "2026-11-01T10:03:00.000Z", recordedAt: "2026-11-01T10:04:00.000Z" };
  const observation = value(auth.sign(unsigned));
  const add = (id: string, type: string, notes: string, at: string) => {
    const row: Record<string, unknown> = { ...structuredClone(native.rows.get("30")!), id, notes, created_at: at, updated_at: at,
      links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` }, recall_type: { links: { self: `https://api.au5.cliniko.com/v1/recall_types/${type}` } } };
    native.rows.set(id, row); return row;
  };
  const originalRow = add("40", "62", value(encodeOutboundLaunchAttempt(attempt)), attempt.attemptedAt);
  const observationRow = add("50", "66", value(encodeTwilioOutboundTerminalObservation(observation)), observation.recordedAt);
  add("60", "99", "unrelated-private-history-note", now);
  const f = await callerVerificationFixture({ scope: native.request.scope, apiKey: native.config.apiKey,
    rateBudget: native.config.rateBudget, patientId: options.patientId ?? native.request.patientId,
    ...(options.nativeRequestCosts ? { nativeRequestCosts: true } : {}),
    now, operation: "appointments.read", cancellationExecute: true, reschedulingExecute: true });
  const lifetime = new AbortController(), queries: Parameters<IncomingCallContextAuthority["current"]>[0][] = [];
  const state: { live: boolean; allowed: boolean; current?: IncomingCallContextAuthority["current"];
    allow?: (q: Parameters<IncomingCallContextAuthority["current"]>[0]) => boolean | Promise<boolean>;
    beforeFetch?: (url: URL, signal: AbortSignal) => void | Promise<void>;
    page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response>;
  } = { live: true, allowed: true };
  const allow = async (q: Parameters<IncomingCallContextAuthority["current"]>[0]) => { queries.push(q); return state.allow ? state.allow(q) : state.allowed; };
  const authority: IncomingCallContextAuthority = { allowsHistoryRead: allow, allowsPurpose: allow, allowsRequestRead: allow,
    allowsAttemptRead: allow, allowsObservationRead: allow, current: (q, signal) => state.live && (!state.current || state.current(q, signal)) };
  let lists = 0;
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); await state.beforeFetch?.(url, init!.signal!);
    if (url.pathname.startsWith("/v1/individual_appointments/")) return target.port(input, init);
    if (url.pathname !== "/v1/recalls") return native.port(input, init);
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.deepEqual(url.searchParams.getAll("q[]"), [`patient_id:=${options.patientId ?? native.request.patientId}`, "archived_at:*"]);
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${native.config.apiKey}:`).toString("base64")}`);
    lists++;
    const rows = [...native.rows.values()].filter(row => (row.patient as { links: { self: string } }).links.self.endsWith(`/${options.patientId ?? native.request.patientId}`))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const page = Number(url.searchParams.get("page"));
    return state.page ? state.page(rows, page) : Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
  const unansweredAuth = new TwilioOutboundUnansweredObservationAuthentication(Buffer.alloc(32, 31), attempt.provider);
  const provision = { requests: native.config,
    attempts: { ...native.config, outboundAttemptRecallTypeId: "62", attemptPolicyDigest: "b".repeat(64) },
    observations: { ...native.config, outboundTerminalObservationRecallTypeId: "66", terminalObservationPolicyDigest: "c".repeat(64) },
    unanswered: { records: { ...native.config, outboundUnansweredObservationRecallTypeId: "67", unansweredObservationPolicyDigest: "e".repeat(64) }, authentication: unansweredAuth },
    authentication: auth, accountSid, lookBackMs: 3_600_000, readPolicyDigest: "f".repeat(64), authority,
    ...(options.sickDay ? { target: { appointmentPolicyDigest: target.config.appointmentPolicyDigest, authority: target.authority } } : {}) };
  const config = { ...provision, receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
    policyVersion: f.sessionConfig.policyVersion, signal: lifetime.signal, fetchPort: port };
  const make = () => ClinikoIncomingCallContext.create(config), context = value(make());
  const replaceWithUnanswered = () => {
    const observation = value(unansweredAuth.sign({ ...unsigned, status: "no-answer", actionRef: twilioOutboundUnansweredActionRef(unsigned.sessionActionRef)! }));
    native.rows.delete("50");
    const row = add("51", "67", value(encodeTwilioOutboundUnansweredObservation(observation)), observation.recordedAt);
    return { observation, row, authentication: unansweredAuth };
  };
  const successors: CallerVerificationSession[] = [];
  const verify = async (session = f.session) => {
    const count = f.mail.length; session.begin();
    const deadline = Date.now() + 5000;
    while (f.mail.length === count && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, count + 1); assert.deepEqual(await session.submitCode(f.mail.at(-1)!.code), { verified: true });
  };
  const successor = async (operation: "appointments.cancel" | "appointments.reschedule") => {
    await f.replaceApproval({ operations: ["appointments.read", operation] });
    const policy = value(await OwnerFileCallerPolicy.capture({ ...f.config, operation }));
    f.session.dispose();
    const session = value(CallerVerificationSession.create({ ...f.sessionConfig, operation, policy })); successors.push(session);
    await verify(session); return session;
  };
  return { ...f, callerConfig: f.config, native, target, attempt, unsigned, observation, auth, originalRow, observationRow, state, queries, config, provision, make, context, verify, successor, add, replaceWithUnanswered,
    get lists() { return lists; },
    read: () => context.read(f.session, lifetime.signal),
    close: async () => { lifetime.abort(); context.dispose(); successors.forEach(s => s.dispose()); await f.close(); } };
}
