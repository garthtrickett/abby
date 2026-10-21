import { visibleCaseRows, visibleArchivedCase } from "./class-pass-history.ts";
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
import type { ClassPassCancellationAuthority, ClassPassCancellationAuthorityQuery, ClassPassCancellationEffect } from "../../src/standalone/cliniko-class-pass-cancellation.ts";
import type { ClassPassSelection } from "../../src/standalone/cliniko-class-pass-booking.ts";
export async function classCancellationFixture(options: { operation?: "appointments.cancel" | "appointments.book"; passes?: ClassPassCancellationEffect;
  scope?: import("../../src/core/model.ts").LocationScope; budget?: import("../../src/cliniko/read-budget.ts").ClinikoRequestBudget; budgetLimit?: 180 | 200;
  verificationBudget?: import("../../src/standalone/email-patient-authority.ts").PatientVerificationBudget;
  fetchAround?: (port: typeof fetch) => typeof fetch;
  memoFor?: (native: import("../../src/cliniko/class-attendance-write.ts").ClinikoAttendanceConfig, clock: () => string) => import("../../src/standalone/administrative-memo-retention.ts").ClinikoAdministrativeMemoConfig } = {}) {
  let sourceTime = verificationNow;
  const nativeBudget = options.budget ?? new ClinikoReadBudget(options.budgetLimit ?? 200, () => Date.parse(sourceTime));
  let claims = 0;
  const budget = { claim: () => { claims++; return nativeBudget.claim(); }, observe429: nativeBudget.observe429.bind(nativeBudget),
    ...(nativeBudget.checkHeadroom ? { checkHeadroom: nativeBudget.checkHeadroom.bind(nativeBudget) } : {}) };
  const f = await callerVerificationFixture({ apiKey: "synthetic-class-au5", cancellationExecute: true, ...(options.operation === "appointments.book" ? { bookingExecute: true } : {}), operation: options.operation ?? "appointments.cancel", rateBudget: budget,
    ...(options.scope ? { scope: options.scope } : {}), ...(options.verificationBudget ? { budget: options.verificationBudget } : {}) });
  let callState = () => f.state();
  const native = classAttendanceFixture({ scope: f.scope, now: verificationNow, patientId: verificationCanaries[2]!, rateBudget: budget });
  native.attendees.splice(0, native.attendees.length, ...native.attendees.filter(row => !["105", "106"].includes(String(row.id))));
  let permitted = true, lostReview = false, lostWrite = false, onRecall = async () => { }, onWrite = async () => { };
  const recalls: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  const lifetime = new AbortController(), path = join(f.folder, "class.json");
  const caseId = "811222333444555666", entitlementRef = "synthetic-private-cancel-entitlement";
  const own = native.attendees.find(row => row.id === "101")!;
  Object.assign(own, { arrived: options.passes === "consumeOne" ? false : null, ...(options.passes ? { patient_case: classLink("patient_cases", caseId) } : {}) });
  const caseRows: Record<string, unknown>[] = [own, { ...classAttendee("601", "81", verificationCanaries[2]!), arrived: true, patient_case: classLink("patient_cases", caseId) }];
  const caseRecord: Record<string, unknown> = { id: caseId, ...classLink("patient_cases", caseId), patient: classLink("patients", verificationCanaries[2]!), attendee_ids: ["101", "601"],
    max_sessions: 2, include_cancelled_attendees: options.passes !== "releaseOne", include_dna_attendees: false, issue_date: "2026-10-01", expiry_date: "2026-10-31",
    closed_at: null, archived_at: null, name: "private-cancel-case-name", notes: "private-cancel-case-notes", referral: "private-cancel-case-referral" };
  let passAllowed = true, effectAllowed = true, selection: ClassPassSelection = { patientCaseId: caseId, entitlementRef }, onCaseRead = (_path: string) => {};
  const passQueries: ClassPassCancellationAuthorityQuery[] = [];
  const passAuthority: ClassPassCancellationAuthority = { select: async query => {
    passQueries.push(query);
    return passAllowed && (!query.effect || effectAllowed && query.effect === options.passes) && query.operation === "cancel" && query.attendeeId === "101" &&
      query.patientId === verificationCanaries[2] && query.classSessionId === "91" && query.serviceRef === "mat-pilates" && query.businessId === "11" &&
      query.practitionerId === "22" && query.appointmentTypeId === "33" && query.passTermsVersion === "pass-cancel-1" && !query.signal.aborted ? structuredClone(selection) : undefined;
  } };
  let approval: ClassApproval = { scope: f.scope, revision: "class-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z",
    effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true,
    policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33", credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), recallTypeId: "7",
    timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort", notificationOwner: "cliniko", membership: "independentHost",
    serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", durationMinutes: 60,
    bookingTerms: { version: "class-terms-1", approvedText: "This class costs 12 pounds. Your pass or payment must be checked by the clinic." }, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  if (options.passes) approval = { ...approval, membership: "nativeCaseSessions", caseSessions: { attendanceStatus: "arrivedFalseIsDna", counting: "allLinkedNonArchivedAttendees",
    dates: "inclusiveClinicDate", consumption: "onePerAttendance", financialAuthority: "independentHost", cancellation: { version: "pass-cancel-1",
      releaseOne: "One session will stop counting as used. This does not extend your pass or provide a money refund.",
      unchanged: "Your pass usage will stay unchanged. No money refund is included.",
      consumeOne: "This cancellation will count as one used pass session. No money refund is included." } } };
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
  const baseFetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname.startsWith(`/v1/patient_cases/${caseId}`)) {
      assert.equal(method, "GET"); onCaseRead(url.pathname);
      if (url.pathname === `/v1/patient_cases/${caseId}`) return visibleArchivedCase(url, caseRecord) ? Response.json(caseRecord) : new Response(null, { status: 404 });
      assert.equal(url.pathname, `/v1/patient_cases/${caseId}/attendees`); assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*", "cancelled_at:*", "deleted_at:*"]);
      const page = Number(url.searchParams.get("page")), visible = visibleCaseRows(url, caseRows); return Response.json({ attendees: visible.slice((page - 1) * 100, page * 100), total_entries: visible.length });
    }
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
  const fetchPort = options.fetchAround ? options.fetchAround(baseFetchPort) : baseFetchPort;
  const memo = options.memoFor?.(native.config, () => sourceTime);
  const host = resultValue(await ClinikoClassCancellationHost.create({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, verification: f.session, classPolicy: policy, cancellationPolicy, permission: { allows: async () => permitted },
    ...(options.passes ? { classPassCancellationAuthority: passAuthority } : {}), ...(memo ? { memo } : {}), cliniko: native.config, clock: () => sourceTime, signal: lifetime.signal, fetchPort }));
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
    classPermission: { allows: async () => permitted }, ...(options.passes ? { classPassCancellationAuthority: passAuthority } : {}), ...(memo ? { memo } : {}), cliniko: { ...native.config, timeZone: approval.timeZone, countryCallingCode: "61", recallTypeId: "7" },
    signal: lifetime.signal, fetchPort, clock: () => sourceTime, cancellationApprovalPath: cancellationPath };
  return { ...f, classSessionConfig, bindNativeCall: (read: typeof callState) => { callState = read; }, native, host, reception, agent, recalls, writes, policy, path, cancellationPolicy, cancellationPath, turn, play, verify, propose, confirm,
    pass: { caseId, entitlementRef, record: caseRecord, rows: caseRows, queries: passQueries, authority: passAuthority, deny: () => { passAllowed = false; },
      denyEffect: () => { effectAllowed = false; }, select: (value: ClassPassSelection) => { selection = value; }, onRead: (hook: typeof onCaseRead) => { onCaseRead = hook; } },
    pause: async (seconds: number) => {
      while (seconds > 0) { const step = Math.min(15, seconds); sourceTime = new Date(Date.parse(sourceTime) + step * 1000).toISOString(); f.setTime(sourceTime);
        resultValue(await f.runtime.renewSession(f.callId, f.sessionId, (await f.state()).sessionLease!.version, sourceTime)); seconds -= step; }
    },
    drain: () => reception.drain(f.scope, f.callId, sourceTime), get claims() { return claims; }, get approval() { return approval; },
    permission: (value: boolean) => { permitted = value; }, loseReview: () => { lostReview = true; }, loseWrite: () => { lostWrite = true; },
    onRecall: (hook: () => Promise<void>) => { onRecall = hook; }, onWrite: (hook: () => Promise<void>) => { onWrite = hook; },
    replacePolicy: async (patch: Partial<ClassApproval>) => { approval = { ...approval, ...patch }; await writeFile(path, JSON.stringify(approval), { mode: 0o600 }); },
    replaceCancellation: async (patch: Partial<CancellationApproval>) => { cancellationApproval = { ...cancellationApproval, ...patch }; await writeFile(cancellationPath, JSON.stringify(cancellationApproval), { mode: 0o600 }); },
    setTime: (value: string) => { sourceTime = value; f.setTime(value); },
    discovery: async () => resultValue(await resultValue(ClinikoRecallReader.create({ ...native.config, scope: f.scope }, fetchPort, () => sourceTime)).discoverPendingReviews(f.scope, "7")),
    close: async () => { lifetime.abort(); host.dispose(); await f.close(); } };
}
