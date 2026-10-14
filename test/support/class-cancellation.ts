import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoClassCancellationHost } from "../../src/standalone/cliniko-class-cancellation-host.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileCancellationPolicy } from "../../src/standalone/owner-file-cancellation-policy.ts";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import type { ClassApproval } from "../../src/standalone/owner-file-class-policy.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { classAttendanceFixture, classAttendee, classLink, classBase as base } from "./class-attendance.ts";
import { callerVerificationFixture, verificationNow, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
export async function classCancellationFixture(options: { operation?: "appointments.cancel" | "appointments.book" } = {}) {
  const nativeBudget = new ClinikoReadBudget(200, () => Date.parse(verificationNow));
  let claims = 0;
  const budget = { claim: () => { claims++; return nativeBudget.claim(); }, observe429: nativeBudget.observe429.bind(nativeBudget) };
  const f = await callerVerificationFixture({ apiKey: "synthetic-class-au5", cancellationExecute: true, ...(options.operation === "appointments.book" ? { bookingExecute: true } : {}), operation: options.operation ?? "appointments.cancel", rateBudget: budget });
  let callState = () => f.state();
  const native = classAttendanceFixture({ scope: f.scope, now: verificationNow, patientId: verificationCanaries[2]!, rateBudget: budget });
  native.attendees.splice(0, native.attendees.length, ...native.attendees.filter(row => !["105", "106"].includes(String(row.id))));
  let permitted = true, lostReview = false, lostWrite = false, sourceTime = verificationNow, onRecall = async () => { }, onWrite = async () => { };
  const recalls: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  const lifetime = new AbortController(), path = join(f.folder, "class.json");
  let approval: ClassApproval = { scope: f.scope, revision: "class-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z",
    effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true,
    policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33", credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), recallTypeId: "7",
    timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort", notificationOwner: "cliniko", membership: "independentHost",
    serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", durationMinutes: 60,
    bookingTerms: { version: "class-terms-1", approvedText: "This class costs 12 pounds. Your pass or payment must be checked by the clinic." }, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const policy = resultValue(await OwnerFileClassPolicy.capture({ path, scope: f.scope, policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33",
    credentialFingerprint: approval.credentialFingerprint, recallTypeId: "7", timeZone: approval.timeZone, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock: () => sourceTime }));
  const cancellationPath = join(f.folder, "class-cancel.json");
  let cancellationApproval: CancellationApproval = { scope: f.scope, revision: "class-cancel-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z",
    effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion,
    businessId: "11", credentialFingerprint: approval.credentialFingerprint, recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort", notificationOwner: "cliniko",
    cancellationReason: 50, lateNoticeHours: 24, maxAdvanceDays: 30, standardTerms: { version: "class-cancel-standard-1", approvedText: "No cancellation fee applies." }, lateTerms: { version: "class-cancel-late-1", approvedText: "A late cancellation fee applies." } };
  await writeFile(cancellationPath, JSON.stringify(cancellationApproval), { mode: 0o600 });
  const cancellationPolicy = resultValue(await OwnerFileCancellationPolicy.capture({ path: cancellationPath, ...policy.binding(), directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock: () => sourceTime }));
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === "/v1/recalls") {
      if (method === "GET")
        return Response.json({ recalls, total_entries: recalls.length });
      assert.equal(method, "POST");
      const body = JSON.parse(String(init?.body));
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes, patient: classLink("patients", body.patient_id), recall_type: classLink("recall_types", "7") };
      recalls.push(row);
      await onRecall();
      if (lostReview)
        throw new Error("synthetic lost class review response");
      return Response.json(row, { status: 201 });
    }
    if (/^\/v1\/attendees\/[1-9][0-9]*\/cancel$/.test(url.pathname) && method === "PATCH") {
      assert.equal(recalls.length, 1);
      const dispatched = Object.values((await callState()).actions).filter(action => action.status === "dispatched");
      assert.equal(dispatched.length, 1);
      const action = dispatched[0]!;
      assert.equal(action.status, "dispatched");
      assert.equal((await callState()).presentations[action.presentationId]!.status, "played");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
      writes.push(body);
      const row = native.attendees.find(row => row.id === url.pathname.split("/").at(-2))!;
      row.cancelled_at = sourceTime;
      row.cancellation_reason = body.cancellation_reason;
      await onWrite();
      if (lostWrite)
        throw new Error("synthetic lost class cancellation response");
      return new Response(null, { status: 204 });
    }
    if (/^\/v1\/attendees\/[1-9][0-9]*$/.test(url.pathname)) {
      assert.equal(method, "GET");
      return Response.json(native.attendees.find(row => row.id === url.pathname.split("/").at(-1)));
    }
    if (url.pathname.startsWith("/v1/patients/")) return f.fetchPort(value, init);
    return native.fetchPort(value, init);
  };
  const host = resultValue(await ClinikoClassCancellationHost.create({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, verification: f.session, classPolicy: policy, cancellationPolicy, permission: { allows: async () => permitted }, cliniko: native.config, clock: () => sourceTime, signal: lifetime.signal, fetchPort }));
  const reception = new TextReception(f.ledger, f.policies, host, undefined, host, undefined, undefined, () => sourceTime), agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
  let turns = 0;
  const turn = (name: string, text = "Cancel my class") => ({ callId: f.callId, sessionId: f.sessionId, turnId: `class-${name}-${++turns}`, text, quality: "clear" as const, at: sourceTime });
  const play = async () => {
    const state = await f.state(), pending = state.pendingPresentationId;
    if (pending) {
      resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, sourceTime));
      resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, sourceTime));
    }
  };
  const verify = async () => {
    await play();
    assert.match(f.session.begin().prompt, /verification code/);
    for (let i = 0; i < 50 && !f.mail.length; i++)
      await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.mail.length, 1);
    assert.equal((await f.session.submitCode(f.mail[0]!.code)).verified, true);
  };
  const propose = async () => {
    const grant = await f.session.verified();
    assert.ok(grant);
    resultValue(await agent.submit({ kind: "appointments.read.v1", turn: turn("read"), verificationRef: grant.verificationRef, from: sourceTime, to: "2026-10-09T10:00:00.000Z", now: sourceTime }));
    assert.equal((await f.state()).appointmentReads.at(-1)!.status, "shown");
    await play();
    resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: turn("cancel"), selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: sourceTime }));
    const action = Object.values((await f.state()).actions).at(-1)!;
    assert.equal(action.status, "awaitingConfirmation");
    return action;
  };
  const confirm = async (played = true) => {
    if (played)
      await play();
    const action = Object.values((await f.state()).actions).at(-1)!;
    return reception.affirm(f.scope, turn("yes", "Yes"), action.key, action.digest, sourceTime);
  };
  const classSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, permission: f.sessionConfig.permission,
    verificationBudget: f.sessionConfig.budget, delivery: f.sessionConfig.delivery, directory: f.config.directory,
    callerApprovalPath: f.config.path, classApprovalPath: path, operation: "cancel" as const,
    classPermission: { allows: async () => permitted }, cliniko: { ...native.config, timeZone: approval.timeZone, countryCallingCode: "61", recallTypeId: "7" },
    signal: lifetime.signal, fetchPort, clock: () => sourceTime, cancellationApprovalPath: cancellationPath };
  return { ...f, classSessionConfig, bindNativeCall: (read: typeof callState) => { callState = read; }, native, host, reception, agent, recalls, writes, policy, path, cancellationPolicy, cancellationPath, turn, play, verify, propose, confirm,
    drain: () => reception.drain(f.scope, f.callId, sourceTime), get claims() { return claims; }, get approval() { return approval; },
    permission: (value: boolean) => { permitted = value; }, loseReview: () => { lostReview = true; }, loseWrite: () => { lostWrite = true; },
    onRecall: (hook: () => Promise<void>) => { onRecall = hook; }, onWrite: (hook: () => Promise<void>) => { onWrite = hook; },
    replacePolicy: async (patch: Partial<ClassApproval>) => { approval = { ...approval, ...patch }; await writeFile(path, JSON.stringify(approval), { mode: 0o600 }); },
    replaceCancellation: async (patch: Partial<CancellationApproval>) => { cancellationApproval = { ...cancellationApproval, ...patch }; await writeFile(cancellationPath, JSON.stringify(cancellationApproval), { mode: 0o600 }); },
    setTime: (value: string) => { sourceTime = value; f.setTime(value); },
    discovery: async () => resultValue(await resultValue(ClinikoRecallReader.create({ ...native.config, scope: f.scope }, fetchPort, () => sourceTime)).discoverPendingReviews(f.scope, "7")),
    close: async () => { lifetime.abort(); host.dispose(); await f.close(); } };
}
