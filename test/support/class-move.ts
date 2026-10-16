import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoClassMoveHost } from "../../src/standalone/cliniko-class-move-host.ts";
import type { ClassMovePermission } from "../../src/standalone/cliniko-class-move-host.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import type { ClassApproval } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "../../src/standalone/owner-file-class-move-policy.ts";
import type { ClassMoveApproval } from "../../src/standalone/owner-file-class-move-policy.ts";
import { classAttendanceFixture, classAttendee, classLink } from "./class-attendance.ts";
import { callerVerificationFixture, verificationNow, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import type { ClassPassMoveAuthority, ClassPassMoveAuthorityQuery } from "../../src/standalone/cliniko-class-pass-movement.ts";
import { addCaseHistory, addClassRosterHistory, visibleCaseRows, visibleArchivedCase } from "./class-pass-history.ts";

export type PassMoveOptions = Readonly<{ differentCase?: boolean; effect?: "releaseOne" | "unchanged" | "consumeOne"; full?: boolean; history?: number; rosterHistory?: number }>;

export async function classMoveFixture(different = false, near = false, passes?: PassMoveOptions, staging = false, activate = true) {
  let claims = 0, now = verificationNow;
  const budget = new ClinikoReadBudget(180, () => Date.parse(now));
  const windows = new Map<number, number>();
  const rateBudget = { claim: () => { claims++; const result = budget.claim(); if (result === null) { const window = Math.floor((Date.parse(now) - Date.parse(verificationNow)) / 60000); windows.set(window, (windows.get(window) ?? 0) + 1); } return result; }, observe429: budget.observe429.bind(budget), checkHeadroom: budget.checkHeadroom.bind(budget), withReservation: budget.withReservation.bind(budget) };
  const f = await callerVerificationFixture({ apiKey: "synthetic-class-au5", operation: "appointments.reschedule", reschedulingExecute: true, rateBudget, activate, nativeRequestCosts: staging });
  const native = classAttendanceFixture({ scope: f.scope, now, patientId: verificationCanaries[2]!, rateBudget });
  native.groups.splice(1, 2);
  Object.assign(native.groups[1]!, { starts_at: "2026-10-09T10:00:00.000Z", ends_at: different ? "2026-10-09T10:30:00.000Z" : "2026-10-09T11:00:00.000Z",
    ...(different ? { practitioner: classLink("practitioners", "23"), appointment_type: classLink("appointment_types", "34") } : {}) });
  if (near) Object.assign(native.groups[1]!, { starts_at: new Date(Date.parse(now) + 61 * 60000).toISOString(), ends_at: new Date(Date.parse(now) + 121 * 60000).toISOString() });
  if (different) native.business.appointment_type_ids = ["33", "34"];
  if (passes?.rosterHistory) for (const [side, group] of ["91", "94"].entries()) addClassRosterHistory(native.attendees, group, passes.rosterHistory, now, 700000 + side * 1000);
  const sourceCaseId = "811222333444555666", destinationCaseId = passes?.differentCase ? "811222333444555667" : sourceCaseId;
  const caseOf = (row: Record<string, unknown>) => (row.patient_case as { links?: { self?: string } } | undefined)?.links?.self?.split("/").at(-1);
  const caseRows = (id: string) => native.attendees.filter(row => caseOf(row) === id);
  const records: Record<string, Record<string, unknown>> = {};
  const effect = passes?.effect ?? "releaseOne";
  if (passes) {
    Object.assign(native.attendees.find(row => row.id === "101")!, { arrived: effect === "consumeOne" ? false : null, patient_case: classLink("patient_cases", sourceCaseId) });
    native.attendees.push({ ...classAttendee("601", "701", verificationCanaries[2]!), arrived: true, patient_case: classLink("patient_cases", sourceCaseId) });
    if (passes.differentCase) native.attendees.push({ ...classAttendee("602", "702", verificationCanaries[2]!), arrived: true, patient_case: classLink("patient_cases", destinationCaseId) });
    for (const id of new Set([sourceCaseId, destinationCaseId])) records[id] = { id, ...classLink("patient_cases", id), patient: classLink("patients", verificationCanaries[2]!),
      max_sessions: passes.full ? id === sourceCaseId ? effect === "consumeOne" ? 1 : 2 : 2 : 5, include_cancelled_attendees: id === sourceCaseId && effect !== "releaseOne", include_dna_attendees: false,
      issue_date: "2026-10-01", expiry_date: "2026-10-30", closed_at: null, archived_at: null, name: "synthetic-private-move-pass-name", notes: "synthetic-private-move-pass-note" };
    if (passes.history) for (const [side, id] of [...new Set([sourceCaseId, destinationCaseId])].entries())
      addCaseHistory(native.attendees, id, verificationCanaries[2]!, passes.history, now, 900000 + side * 10000);
  }
  const lifetime = new AbortController(), sourcePath = join(f.folder, "class-source.json"), destinationPath = join(f.folder, "class-destination.json"), movePath = join(f.folder, "class-move.json");
  let source: ClassApproval = { scope: f.scope, revision: "source-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: now,
    effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33",
    credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), recallTypeId: "7", timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort",
    notificationOwner: "cliniko", membership: "independentHost", serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", durationMinutes: 60,
    bookingTerms: { version: "class-book-1", approvedText: "This class costs 12 pounds." }, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  let destination: ClassApproval = { ...source, ...(different ? { revision: "destination-1", practitionerId: "23", appointmentTypeId: "34", serviceRef: "reformer-pilates", className: "Reformer Pilates", practitionerName: "Second Instructor", durationMinutes: 30 } : {}) };
  if (passes) {
    const caseSessions = { attendanceStatus: "arrivedFalseIsDna", counting: "allLinkedNonArchivedAttendees", dates: "inclusiveClinicDate", consumption: "onePerAttendance", financialAuthority: "independentHost" } as const;
    source = { ...source, membership: "nativeCaseSessions", caseSessions }; destination = { ...destination, membership: "nativeCaseSessions", caseSessions };
  }
  let move: ClassMoveApproval = { scope: f.scope, revision: "move-1", approverRef: f.account.actor.actorRef, approvedAt: source.approvedAt, effectiveFrom: now, effectiveUntil: source.effectiveUntil,
    approved: true, enabled: true, policyVersion: source.policyVersion, businessId: "11", credentialFingerprint: source.credentialFingerprint, recallTypeId: "7", timeZone: source.timeZone,
    sourceServiceRef: source.serviceRef, destinationServiceRef: destination.serviceRef, writeContract: "bestEffort", notificationOwner: "cliniko", membership: "independentHost", compensation: "cancelReplacementIfOriginalUnsent",
    cancellationReason: 50, lateNoticeHours: 24, maxAdvanceDays: 30, offerTtlSeconds: 120, standardTerms: { version: "standard-1", approvedText: "No move fee applies." },
    lateTerms: { version: "late-1", approvedText: "A late move fee applies." }, recoveryTerms: { version: "recovery-1", approvedText: "We book the replacement before cancelling the original. If original cancellation was never sent, we may cancel only the replacement and retain the original." } };
  if (passes) move = { ...move, membership: "nativeCaseSessions", recoveryTerms: { version: "pass-recovery-1", approvedText: "If the move cannot finish, staff may need to confirm the replacement. If we have not sent the original cancellation, we may cancel only the replacement." },
    passMovement: { version: "pass-move-v1", staging: "unlinkedReplacement", association: "afterOriginalCancellation", financialAuthority: "independentHost",
      sameCaseUnchanged: "This move keeps your pass session use unchanged.", sameCaseConsumeOne: "This move uses one additional pass session.", sameCaseConsumeTwo: "This move uses two additional pass sessions.",
      differentCaseReleaseOne: "Your original pass releases one session and your destination pass uses one session.", differentCaseUnchanged: "Your original pass use is unchanged and your destination pass uses one session.",
      differentCaseConsumeOne: "Your original pass uses one additional session and your destination pass uses one session." } };
  if (staging) move = { ...move, quotaStaging: { version: move.passMovement?.version ?? "ordinary-stages-v1" } };
  for (const [path, value] of [[sourcePath, source], [destinationPath, destination], [movePath, move]] as const) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const binding = { scope: f.scope, policyVersion: source.policyVersion, businessId: "11", credentialFingerprint: source.credentialFingerprint, recallTypeId: "7", timeZone: source.timeZone,
    directory: f.config.directory, clock: () => now };
  const sourcePolicy = resultValue(await OwnerFileClassPolicy.capture({ ...binding, path: sourcePath, practitionerId: source.practitionerId, appointmentTypeId: source.appointmentTypeId }));
  const destinationPolicy = resultValue(await OwnerFileClassPolicy.capture({ ...binding, path: destinationPath, practitionerId: destination.practitionerId, appointmentTypeId: destination.appointmentTypeId }));
  const movePolicy = resultValue(await OwnerFileClassMovePolicy.capture({ ...binding, path: movePath, sourceServiceRef: source.serviceRef, destinationServiceRef: destination.serviceRef }));
  let lost: "review" | "replacement" | "original" | "compensation" | "association" | undefined, permitted = true;
  let phasePermission: (phase: Parameters<ClassMovePermission["allows"]>[0]["phase"]) => boolean = () => true;
  let onWrite: ((phase: string) => void | Promise<void>) | undefined;
  const recalls: Record<string, unknown>[] = [], writes: { path: string; body: Record<string, unknown> }[] = [];
  let callState = f.state;
  let passAllowed = true, selection = { source: { patientCaseId: sourceCaseId, entitlementRef: "private-move-source-entitlement" }, destination: { patientCaseId: destinationCaseId, entitlementRef: "private-move-destination-entitlement" } };
  const passQueries: ClassPassMoveAuthorityQuery[] = [];
  const casePages: { caseId: string; page: number; total: number }[] = [];
  let onCaseRead = (_path: string) => {};
  let passAuthority: ClassPassMoveAuthority = { select: async query => { passQueries.push(query); return passAllowed ? structuredClone(selection) : undefined; },
    allows: async query => passAllowed && query.patientId === verificationCanaries[2] && query.stagingContractVersion === move.passMovement?.version && query.binding.source.effect === effect };
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname.startsWith("/v1/patients/")) return f.fetchPort(value, init);
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)), row = { id: "71", ...classLink("recalls", "71"), updated_at: now, archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: classLink("patients", body.patient_id), recall_type: classLink("recall_types", "7") };
      recalls.push(row); if (lost === "review") throw new Error("synthetic lost class move review");
      return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/recalls/71" && method === "GET") return recalls.length ? Response.json(recalls[0]) : new Response(null, { status: 404 });
    if (method === "POST" || method === "PATCH") {
      assert.equal(recalls.length, 1);
      const dispatched = Object.values((await callState()).actions).filter(action => action.status === "dispatched");
      assert.equal(dispatched.length, 1); assert.equal((await callState()).presentations[dispatched[0]!.presentationId]!.status, "played");
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      const phase = method === "POST" ? "replacement" : passes && url.pathname === "/v1/attendees/401" ? "association" : url.pathname.includes("/101/") ? "original" : "compensation";
      let row: Record<string, unknown>;
      if (method === "POST") { assert.equal(url.pathname, "/v1/attendees"); row = { ...classAttendee("401", body.booking_id, body.patient_id), notes: body.notes, arrived: null }; native.attendees.push(row); }
      else if (phase === "association") { assert.deepEqual(body, { patient_case_id: destinationCaseId }); row = native.attendees.find(row => row.id === "401")!; row.patient_case = classLink("patient_cases", body.patient_case_id); }
      else {
        assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        assert.match(url.pathname, /^\/v1\/attendees\/(?:101|401)\/cancel$/);
        row = native.attendees.find(row => row.id === (phase === "original" ? "101" : "401"))!; row.cancelled_at = now; row.cancellation_reason = body.cancellation_reason;
      }
      await onWrite?.(phase); if (lost === phase) throw new Error("synthetic lost class move leg");
      return method === "POST" ? Response.json(row, { status: 201 }) : phase === "association" ? Response.json(row) : new Response(null, { status: 204 });
    }
    if (/^\/v1\/attendees\/[1-9][0-9]*$/.test(url.pathname)) return Response.json(native.attendees.find(row => row.id === url.pathname.split("/").at(-1)));
    if (passes && url.pathname.startsWith("/v1/patient_cases/")) {
      onCaseRead(url.pathname);
      const id = url.pathname.split("/")[3]!, all = caseRows(id).sort((a, b) => String(a.id).localeCompare(String(b.id))), rows = visibleCaseRows(url, all);
      if (url.pathname.endsWith("/attendees")) casePages.push({ caseId: id, page: Number(url.searchParams.get("page")), total: rows.length });
      assert.ok(records[id]); return url.pathname.endsWith("/attendees") ? Response.json({ attendees: rows.slice((Number(url.searchParams.get("page")) - 1) * 100, Number(url.searchParams.get("page")) * 100), total_entries: rows.length }) :
        visibleArchivedCase(url, records[id]!) ? Response.json({ ...records[id], attendee_ids: all.map(row => row.id) }) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/v1/attendees" && url.searchParams.getAll("q[]").includes("patient_case_id:!?")) {
      const filters = url.searchParams.getAll("q[]"), id = filters.find(v => v.startsWith("id:="))?.slice(4);
      const patient = filters.find(v => v.startsWith("patient_id:="))?.slice("patient_id:=".length),
        booking = filters.find(v => v.startsWith("booking_id:="))?.slice("booking_id:=".length);
      assert.ok(id && patient && booking);
      const rows = native.attendees.filter(row => row.id === id && !caseOf(row) &&
        (row.patient as { links: { self: string } }).links.self === classLink("patients", patient).links.self &&
        (row.booking as { links: { self: string } }).links.self === classLink("bookings", booking).links.self &&
        (row.cancelled_at === null || filters.includes("cancelled_at:*")));
      return Response.json({ attendees: rows, total_entries: rows.length });
    }
    if (different) {
      if (url.pathname === "/v1/practitioners/23") return Response.json({ id: "23", active: true });
      if (url.pathname === "/v1/appointment_types/34") return Response.json({ id: "34", archived_at: null, max_attendees: 10 });
      if (url.pathname === "/v1/practitioners/23/businesses") return Response.json({ businesses: [{ id: "11", ...classLink("businesses", "11") }], total_entries: 1 });
      if (url.pathname === "/v1/practitioners/23/appointment_types") return Response.json({ appointment_types: [{ id: "34", ...classLink("appointment_types", "34") }], total_entries: 1 });
    }
    const response = await native.fetchPort(value, init);
    if (url.pathname !== "/v1/group_appointments") return response;
    const body = await response.json() as { group_appointments: Record<string, unknown>[] };
    const filters = url.searchParams.getAll("q[]");
    const expected = (name: string) => filters.find(item => item.startsWith(`${name}:=`))?.slice(`${name}:=`.length);
    const from = filters.find(item => item.startsWith("starts_at:>="))?.slice("starts_at:>=".length), to = filters.find(item => item.startsWith("starts_at:<"))?.slice("starts_at:<".length);
    const groups = body.group_appointments.filter(row => (!from || String(row.starts_at) >= from) && (!to || String(row.starts_at) < to) &&
      (row.practitioner as { links: { self: string } }).links.self.endsWith(`/practitioners/${expected("practitioner_id")}`) &&
      (row.appointment_type as { links: { self: string } }).links.self.endsWith(`/appointment_types/${expected("appointment_type_id")}`));
    return Response.json({ group_appointments: groups, total_entries: groups.length });
  };
  let permission: ClassMovePermission = { allows: async query => permitted && phasePermission(query.phase) };
  if (staging) {
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), budget: rateBudget };
    permission = { allows: declareClinikoRequestCost(permission.allows, binding, 0) };
    passAuthority = { select: declareClinikoRequestCost(passAuthority.select, binding, 0), allows: declareClinikoRequestCost(passAuthority.allows, binding, 0) };
  }
  const config = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: source.policyVersion, ledger: f.ledger, policies: f.policies, verification: f.session,
    sourcePolicy, destinationPolicy, movePolicy, permission, cliniko: native.config, clock: () => now, signal: lifetime.signal, fetchPort,
    ...(passes ? { classPassMoveAuthority: passAuthority } : {}) };
  const host = resultValue(await ClinikoClassMoveHost.create(config));
  const reception = new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, () => now);
  let count = 0;
  const turn = (label: string, text = label) => ({ callId: f.callId, sessionId: f.sessionId, turnId: `class-move-${label}-${++count}`, text, quality: "clear" as const, at: now });
  const play = async () => { const id = (await f.state()).pendingPresentationId; if (id) { resultValue(await f.runtime.startPresentation(f.callId, id, f.sessionId, now)); resultValue(await f.runtime.resolvePresentation(f.callId, id, "played", f.sessionId, now)); } };
  const verify = async () => { await play(); f.session.begin(); for (let index = 0; index < 100 && !f.mail.length; index++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.mail.length, 1); assert.equal((await f.session.submitCode(f.mail[0]!.code)).verified, true); };
  const steps: { stage: string; claims: number; text: string }[] = [];
  const record = async (stage: string) => { const state = await f.state(); const shown = state.pendingPresentationId ? state.presentations[state.pendingPresentationId] : undefined; steps.push({ stage, claims, text: shown && "approvedText" in shown ? shown.approvedText : state.callerMessages.at(-1) ?? "" }); };
  const prepare = async (activeReception = reception) => {
    resultValue(await activeReception.readReschedulingMenu(f.scope, turn("targets"), "targets", "2026-10-08", "2026-10-08", now)); await record("targets"); await play();
    resultValue(await activeReception.selectReschedulingMenu(f.scope, turn("target-one", "one"), "targets", 1, now)); await record("targetSelected"); await play();
    resultValue(await activeReception.readReschedulingMenu(f.scope, turn("offers"), "offers", near ? "2026-10-04" : "2026-10-09", near ? "2026-10-04" : "2026-10-09", now)); await record("offers"); await play();
    resultValue(await activeReception.selectReschedulingMenu(f.scope, turn("offer-one", "one"), "offers", 1, now));
    const selected = await f.state(), notice = selected.pendingPresentationId ? selected.presentations[selected.pendingPresentationId] : undefined;
    if (staging && notice?.kind === "notice" && notice.confirmationWaitSeconds !== undefined) {
      assert.match(notice.approvedText, /choose your option again/);
      assert.ok(notice.confirmationWaitSeconds >= 1 && notice.confirmationWaitSeconds <= 60);
      assert.equal(Object.keys(selected.actions).length, 0); assert.equal(writes.length, 0); assert.equal(recalls.length, 0);
      await record("proposalWait"); await play(); await pause(notice.confirmationWaitSeconds + 1);
      resultValue(await activeReception.selectReschedulingMenu(f.scope, turn("offer-after-wait", "one"), "offers", 1, now));
    }
    await record("offerSelected");
    const action = Object.values((await f.state()).actions).at(-1); assert.equal(action?.status, "awaitingConfirmation", JSON.stringify({ claims, steps, last: (await f.state()).callerMessages.at(-1) })); return action!;
  };
  const pause = async (seconds: number) => {
    let remaining = seconds;
    while (remaining > 0) { const step = Math.min(15, remaining); now = new Date(Date.parse(now) + step * 1000).toISOString(); f.setTime(now);
      resultValue(await f.runtime.renewSession(f.callId, f.sessionId, (await f.state()).sessionLease!.version, now)); remaining -= step; }
  };
  const classSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: source.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, permission: f.sessionConfig.permission,
    verificationBudget: f.sessionConfig.budget, delivery: f.sessionConfig.delivery, directory: f.config.directory,
    callerApprovalPath: f.path, classApprovalPath: sourcePath, operation: "reschedule" as const,
    classPermission: permission, moveApprovalPath: movePath, destination: { classApprovalPath: destinationPath, practitionerId: destination.practitionerId, appointmentTypeId: destination.appointmentTypeId },
    ...(passes ? { classPassMoveAuthority: passAuthority } : {}),
    cliniko: { ...native.config, timeZone: source.timeZone, countryCallingCode: "61", recallTypeId: "7" }, signal: lifetime.signal, fetchPort, clock: () => now };
  return { ...f, classSessionConfig, bindNativeCall: (read: typeof callState) => { callState = read; }, native, host, reception, config, sourcePath, destinationPath, movePath, recalls, writes, steps, turn, play, verify, prepare,
    movePass: passes ? { sourceCaseId, destinationCaseId, records, queries: passQueries, casePages, caseRows, deny: () => { passAllowed = false; },
      select: (next: typeof selection) => { selection = structuredClone(next); }, selection: () => structuredClone(selection), onRead: (hook: typeof onCaseRead) => { onCaseRead = hook; } } : undefined,
    get claims() { return claims; }, get windowClaims() { return [...windows.values()]; }, pause, setTime: (value: string) => { now = value; f.setTime(value); }, permit: (value: boolean) => { permitted = value; },
    phasePermission: (allow: typeof phasePermission) => { phasePermission = allow; }, lose: (phase: NonNullable<typeof lost>) => { lost = phase; }, onWrite: (hook: typeof onWrite) => { onWrite = hook; },
    replaceSource: async (patch: Partial<ClassApproval>) => { source = { ...source, ...patch }; await writeFile(sourcePath, JSON.stringify(source)); },
    replaceDestination: async (patch: Partial<ClassApproval>) => { destination = { ...destination, ...patch }; await writeFile(destinationPath, JSON.stringify(destination)); },
    replaceMove: async (patch: Partial<ClassMoveApproval>) => { move = { ...move, ...patch }; await writeFile(movePath, JSON.stringify(move)); },
    close: async () => { lifetime.abort(); host.dispose(); await f.close(); } };
}
