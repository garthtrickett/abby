import { visibleCaseRows, visibleArchivedCase } from "./class-pass-history.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoClassBookingHost } from "../../src/standalone/cliniko-class-booking-host.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import type { ClassApproval } from "../../src/standalone/owner-file-class-policy.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { classAttendanceFixture, classAttendee, classLink, classBase as base } from "./class-attendance.ts";
import { callerVerificationFixture, verificationNow, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import type { ClassPassAuthority, ClassPassAuthorityQuery, ClassPassSelection } from "../../src/standalone/cliniko-class-pass-booking.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { FinancialBookingPreparationConfig } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
export async function classBookingFixture(options: { passes?: boolean; fetchAround?: (port: typeof fetch) => typeof fetch;
  scope?: LocationScope; folder?: string; budget?: ClinikoRequestBudget; budgetLimit?: 180 | 200; verificationBudget?: PatientVerificationBudget;
  financialFor?: (native: import("../../src/cliniko/class-attendance-write.ts").ClinikoAttendanceConfig, port: typeof fetch) => FinancialBookingPreparationConfig } = {}) {
  let sourceTime = verificationNow;
  const nativeBudget = options.budget ?? new ClinikoReadBudget(options.budgetLimit ?? 200, () => Date.parse(sourceTime));
  let claims = 0;
  const budget = { claim: () => { claims++; return nativeBudget.claim(); }, observe429: nativeBudget.observe429.bind(nativeBudget),
    ...(nativeBudget.checkHeadroom ? { checkHeadroom: nativeBudget.checkHeadroom.bind(nativeBudget) } : {}),
    ...(nativeBudget.withReservation ? { withReservation: nativeBudget.withReservation.bind(nativeBudget) } : {}) };
  const mail: { email: string; code: string }[] = [];
  let delivered!: () => void; const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const f = await callerVerificationFixture({ apiKey: "synthetic-class-au5", bookingExecute: true, operation: "appointments.book", rateBudget: budget,
    nativeRequestCosts: options.financialFor !== undefined,
    delivery: { send: async (email, code) => { mail.push({ email, code }); delivered(); return true; } },
    ...(options.scope ? { scope: options.scope } : {}), ...(options.folder ? { folder: options.folder } : {}),
    ...(options.verificationBudget ? { budget: options.verificationBudget } : {}) });
  let callState = () => f.state();
  const native = classAttendanceFixture({ scope: f.scope, now: verificationNow, patientId: verificationCanaries[2]!, rateBudget: budget });
  let permitted = true, lostReview = false, lostWrite = false, onRecall = async () => { }, onWrite = async () => { };
  const costBinding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), budget };
  const permit = async () => permitted;
  const classPermission = { allows: options.financialFor ? declareClinikoRequestCost(permit, costBinding, 0) : permit };
  const recalls: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  const lifetime = new AbortController(), path = join(f.folder, "class.json");
  const caseId = "811222333444555666", entitlementRef = "synthetic-private-pass-entitlement";
  const caseRows: Record<string, unknown>[] = [{ ...classAttendee("601", "81", verificationCanaries[2]!), arrived: true, patient_case: classLink("patient_cases", caseId) }];
  const caseRecord: Record<string, unknown> = { id: caseId, ...classLink("patient_cases", caseId), patient: classLink("patients", verificationCanaries[2]!), attendee_ids: ["601"],
    max_sessions: 2, include_cancelled_attendees: false, include_dna_attendees: false, issue_date: "2026-10-01", expiry_date: "2026-10-31",
    closed_at: null, archived_at: null, name: "private-pass-name-canary", notes: "private-pass-notes-canary", referral: "private-pass-referral-canary" };
  let passAllowed = true, passSelection: ClassPassSelection = { patientCaseId: caseId, entitlementRef }, onCaseRead = (_path: string) => {};
  const passQueries: ClassPassAuthorityQuery[] = [];
  const selectPass: ClassPassAuthority["select"] = async query => {
    passQueries.push(query);
    return passAllowed && query.patientId === verificationCanaries[2] && query.classSessionId === "94" && query.serviceRef === "mat-pilates" &&
      query.businessId === "11" && query.practitionerId === "22" && query.appointmentTypeId === "33" && query.termsVersion === "class-pass-terms-1" &&
      query.startsAt === "2026-10-08T10:00:00.000Z" && query.endsAt === "2026-10-08T11:00:00.000Z" && !query.signal.aborted ? structuredClone(passSelection) : undefined;
  };
  const passAuthority: ClassPassAuthority = { select: options.financialFor ? declareClinikoRequestCost(selectPass, costBinding, 0) : selectPass };
  let approval: ClassApproval = { scope: f.scope, revision: "class-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z",
    effectiveFrom: "2026-10-04T06:00:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true,
    policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33", credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), recallTypeId: "7",
    timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort", notificationOwner: "cliniko", membership: "independentHost",
    serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", durationMinutes: 60,
    bookingTerms: { version: "class-terms-1", approvedText: "This class costs 12 pounds. Your pass or payment must be checked by the clinic." }, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  if (options.passes) approval = { ...approval, membership: "nativeCaseSessions", caseSessions: { attendanceStatus: "arrivedFalseIsDna", counting: "allLinkedNonArchivedAttendees",
    dates: "inclusiveClinicDate", consumption: "onePerAttendance", financialAuthority: "independentHost" },
    bookingTerms: { version: "class-pass-terms-1", approvedText: "This booking uses one session from your approved class pass. Cancellation rules still apply." } };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const policy = resultValue(await OwnerFileClassPolicy.capture({ path, scope: f.scope, policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33",
    credentialFingerprint: approval.credentialFingerprint, recallTypeId: "7", timeZone: approval.timeZone, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock: () => sourceTime }));
  const baseFetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname.startsWith(`/v1/patient_cases/${caseId}`)) {
      assert.equal(method, "GET"); onCaseRead(url.pathname);
      if (url.pathname === `/v1/patient_cases/${caseId}`) return visibleArchivedCase(url, caseRecord) ? Response.json(caseRecord) : new Response(null, { status: 404 });
      assert.equal(url.pathname, `/v1/patient_cases/${caseId}/attendees`);
      assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*", "cancelled_at:*", "deleted_at:*"]);
      const page = Number(url.searchParams.get("page")), visible = visibleCaseRows(url, caseRows);
      return Response.json({ attendees: visible.slice((page - 1) * 100, page * 100), total_entries: visible.length });
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
    if (url.pathname === "/v1/attendees" && method === "POST") {
      assert.equal(recalls.length, 1);
      const dispatched = Object.values((await callState()).actions).filter(action => action.status === "dispatched");
      assert.equal(dispatched.length, 1);
      const action = dispatched[0]!;
      assert.equal(action.status, "dispatched");
      assert.equal((await callState()).presentations[action.presentationId]!.status, "played");
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      const row = { ...classAttendee("401", body.booking_id, body.patient_id), notes: body.notes };
      if (body.patient_case_id !== undefined) {
        Object.assign(row, { arrived: null, patient_case: classLink("patient_cases", body.patient_case_id) });
        caseRows.push(row); (caseRecord.attendee_ids as string[]).push("401");
      }
      native.attendees.push(row);
      await onWrite();
      if (lostWrite)
        throw new Error("synthetic lost class attendee response");
      return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/attendees/401") {
      assert.equal(method, "GET");
      return Response.json(native.attendees.find(row => row.id === "401"));
    }
    if (url.pathname.startsWith("/v1/patients/")) return f.fetchPort(value, init);
    return native.fetchPort(value, init);
  };
  const fetchPort = options.fetchAround ? options.fetchAround(baseFetchPort) : baseFetchPort;
  const financial = options.financialFor?.(native.config, fetchPort);
  const host = resultValue(await ClinikoClassBookingHost.create({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, verification: f.session, classPolicy: policy, permission: classPermission,
    ...(options.passes ? { classPassAuthority: passAuthority } : {}), ...(financial ? { financial } : {}), cliniko: native.config, clock: () => sourceTime, signal: lifetime.signal, fetchPort }));
  const reception = new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, () => sourceTime), agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
  let turns = 0;
  const turn = (name: string, text = "Book a class") => ({ callId: f.callId, sessionId: f.sessionId, turnId: `class-${name}-${++turns}`, text, quality: "clear" as const, at: sourceTime });
  const play = async () => { const state = await f.state(), pending = state.pendingPresentationId; if (pending) {
    resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, sourceTime));
    resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, sourceTime));
  } };
  const verify = async () => { await play(); assert.match(f.session.begin().prompt, /verification code/);
    await delivery; assert.equal(mail.length, 1); assert.equal((await f.session.submitCode(mail[0]!.code)).verified, true); };
  const propose = async () => {
    const checked = await f.state();
    assert.equal(checked.policy.staffWorkEnabled, true, "admitted staff workflow required");
    assert.equal(checked.policy.bookingEnabled, true);
    assert.equal(checked.policy.capabilities.book, "execute");
    assert.equal(host.bookingMenuAvailable(), true);
    assert.equal(reception.bookingMenuEnabled(), true);
    assert.equal(checked.sessionLease!.sessionId, f.sessionId);
    assert.ok(Date.parse(checked.sessionLease!.expiresAt) > Date.parse(sourceTime));
    const menuTurn = turn("menu");
    const read = await reception.readBookingMenu(f.scope, menuTurn, "2026-10-08", "2026-10-08", sourceTime);
    if (!read.ok)
      process.stderr.write(JSON.stringify({ phase: "class-menu", pending: !!checked.pendingPresentationId, claims, traffic: native.traffic.length, lifecycle: checked.lifecycle }) + "\n");
    resultValue(read);
    await play();
    resultValue(await reception.selectBookingMenu(f.scope, turn("choice", "one"), 1, sourceTime));
    const action = Object.values((await f.state()).actions).at(-1)!;
    assert.equal(action.status, "awaitingConfirmation");
    return action;
  };
  const confirm = async (played = true) => { if (played)
    await play(); const action = Object.values((await f.state()).actions).at(-1)!; return reception.affirm(f.scope, turn("yes", "Yes"), action.key, action.digest, sourceTime); };
  const classSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, permission: f.sessionConfig.permission,
    verificationBudget: f.sessionConfig.budget, delivery: f.sessionConfig.delivery, directory: f.config.directory,
    callerApprovalPath: f.config.path, classApprovalPath: path, operation: "book" as const,
    classPermission, ...(options.passes ? { classPassAuthority: passAuthority } : {}), cliniko: { ...native.config, timeZone: approval.timeZone, countryCallingCode: "61", recallTypeId: "7" },
    signal: lifetime.signal, fetchPort, clock: () => sourceTime };
  return { ...f, mail, verificationDelivered: delivery, classSessionConfig: { ...classSessionConfig, ...(financial ? { financial } : {}) }, bindNativeCall: (read: typeof callState) => { callState = read; }, native, host, reception, agent, recalls, writes, policy, path, turn, play, verify, propose, confirm,
    pause: async (seconds: number) => {
      while (seconds > 0) { const step = Math.min(15, seconds); sourceTime = new Date(Date.parse(sourceTime) + step * 1000).toISOString(); f.setTime(sourceTime);
        resultValue(await f.runtime.renewSession(f.callId, f.sessionId, (await f.state()).sessionLease!.version, sourceTime)); seconds -= step; }
    },
    pass: { caseId, entitlementRef, record: caseRecord, rows: caseRows, authority: passAuthority, queries: passQueries,
      deny: () => { passAllowed = false; }, select: (selection: ClassPassSelection) => { passSelection = selection; }, onRead: (hook: typeof onCaseRead) => { onCaseRead = hook; } },
    drain: () => reception.drain(f.scope, f.callId, sourceTime), get claims() { return claims; }, get approval() { return approval; },
    permission: (value: boolean) => { permitted = value; }, loseReview: () => { lostReview = true; }, loseWrite: () => { lostWrite = true; },
    onRecall: (hook: () => Promise<void>) => { onRecall = hook; }, onWrite: (hook: () => Promise<void>) => { onWrite = hook; },
    replacePolicy: async (patch: Partial<ClassApproval>) => { approval = { ...approval, ...patch }; await writeFile(path, JSON.stringify(approval), { mode: 0o600 }); },
    setTime: (value: string) => { sourceTime = value; f.setTime(value); },
    discovery: async () => resultValue(await resultValue(ClinikoRecallReader.create({ ...native.config, scope: f.scope }, fetchPort, () => sourceTime)).discoverPendingReviews(f.scope, "7")),
    close: async () => { lifetime.abort(); host.dispose(); await f.close(); } };
}
