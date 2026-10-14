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

export async function classMoveFixture(different = false, near = false) {
  let claims = 0, now = verificationNow;
  const budget = new ClinikoReadBudget(180, () => Date.parse(now));
  const windows = new Map<number, number>();
  const rateBudget = { claim: () => { claims++; const result = budget.claim(); if (result === null) { const window = Math.floor((Date.parse(now) - Date.parse(verificationNow)) / 60000); windows.set(window, (windows.get(window) ?? 0) + 1); } return result; }, observe429: budget.observe429.bind(budget), checkHeadroom: budget.checkHeadroom.bind(budget) };
  const f = await callerVerificationFixture({ apiKey: "synthetic-class-au5", operation: "appointments.reschedule", reschedulingExecute: true, rateBudget });
  const native = classAttendanceFixture({ scope: f.scope, now, patientId: verificationCanaries[2]!, rateBudget });
  native.groups.splice(1, 2);
  Object.assign(native.groups[1]!, { starts_at: "2026-10-09T10:00:00.000Z", ends_at: different ? "2026-10-09T10:30:00.000Z" : "2026-10-09T11:00:00.000Z",
    ...(different ? { practitioner: classLink("practitioners", "23"), appointment_type: classLink("appointment_types", "34") } : {}) });
  if (near) Object.assign(native.groups[1]!, { starts_at: new Date(Date.parse(now) + 61 * 60000).toISOString(), ends_at: new Date(Date.parse(now) + 121 * 60000).toISOString() });
  if (different) native.business.appointment_type_ids = ["33", "34"];
  const lifetime = new AbortController(), sourcePath = join(f.folder, "class-source.json"), destinationPath = join(f.folder, "class-destination.json"), movePath = join(f.folder, "class-move.json");
  let source: ClassApproval = { scope: f.scope, revision: "source-1", approverRef: f.account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: now,
    effectiveUntil: "2026-10-05T06:00:00.000Z", approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33",
    credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey), recallTypeId: "7", timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort",
    notificationOwner: "cliniko", membership: "independentHost", serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", durationMinutes: 60,
    bookingTerms: { version: "class-book-1", approvedText: "This class costs 12 pounds." }, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  let destination: ClassApproval = { ...source, ...(different ? { revision: "destination-1", practitionerId: "23", appointmentTypeId: "34", serviceRef: "reformer-pilates", className: "Reformer Pilates", practitionerName: "Second Instructor", durationMinutes: 30 } : {}) };
  let move: ClassMoveApproval = { scope: f.scope, revision: "move-1", approverRef: f.account.actor.actorRef, approvedAt: source.approvedAt, effectiveFrom: now, effectiveUntil: source.effectiveUntil,
    approved: true, enabled: true, policyVersion: source.policyVersion, businessId: "11", credentialFingerprint: source.credentialFingerprint, recallTypeId: "7", timeZone: source.timeZone,
    sourceServiceRef: source.serviceRef, destinationServiceRef: destination.serviceRef, writeContract: "bestEffort", notificationOwner: "cliniko", membership: "independentHost", compensation: "cancelReplacementIfOriginalUnsent",
    cancellationReason: 50, lateNoticeHours: 24, maxAdvanceDays: 30, offerTtlSeconds: 120, standardTerms: { version: "standard-1", approvedText: "No move fee applies." },
    lateTerms: { version: "late-1", approvedText: "A late move fee applies." }, recoveryTerms: { version: "recovery-1", approvedText: "We book the replacement before cancelling the original. If original cancellation was never sent, we may cancel only the replacement and retain the original." } };
  for (const [path, value] of [[sourcePath, source], [destinationPath, destination], [movePath, move]] as const) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const binding = { scope: f.scope, policyVersion: source.policyVersion, businessId: "11", credentialFingerprint: source.credentialFingerprint, recallTypeId: "7", timeZone: source.timeZone,
    directory: f.config.directory, clock: () => now };
  const sourcePolicy = resultValue(await OwnerFileClassPolicy.capture({ ...binding, path: sourcePath, practitionerId: source.practitionerId, appointmentTypeId: source.appointmentTypeId }));
  const destinationPolicy = resultValue(await OwnerFileClassPolicy.capture({ ...binding, path: destinationPath, practitionerId: destination.practitionerId, appointmentTypeId: destination.appointmentTypeId }));
  const movePolicy = resultValue(await OwnerFileClassMovePolicy.capture({ ...binding, path: movePath, sourceServiceRef: source.serviceRef, destinationServiceRef: destination.serviceRef }));
  let lost: "review" | "replacement" | "original" | "compensation" | undefined, permitted = true;
  let phasePermission: (phase: Parameters<ClassMovePermission["allows"]>[0]["phase"]) => boolean = () => true;
  let onWrite: ((phase: string) => void | Promise<void>) | undefined;
  const recalls: Record<string, unknown>[] = [], writes: { path: string; body: Record<string, unknown> }[] = [];
  let callState = f.state;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname.startsWith("/v1/patients/")) return f.fetchPort(value, init);
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)), row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: classLink("patients", body.patient_id), recall_type: classLink("recall_types", "7") };
      recalls.push(row); if (lost === "review") throw new Error("synthetic lost class move review");
      return Response.json(row, { status: 201 });
    }
    if (method === "POST" || method === "PATCH") {
      assert.equal(recalls.length, 1);
      const dispatched = Object.values((await callState()).actions).filter(action => action.status === "dispatched");
      assert.equal(dispatched.length, 1); assert.equal((await callState()).presentations[dispatched[0]!.presentationId]!.status, "played");
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      const phase = method === "POST" ? "replacement" : url.pathname.includes("/101/") ? "original" : "compensation";
      let row: Record<string, unknown>;
      if (method === "POST") { assert.equal(url.pathname, "/v1/attendees"); row = { ...classAttendee("401", body.booking_id, body.patient_id), notes: body.notes }; native.attendees.push(row); }
      else {
        assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        assert.match(url.pathname, /^\/v1\/attendees\/(?:101|401)\/cancel$/);
        row = native.attendees.find(row => row.id === (phase === "original" ? "101" : "401"))!; row.cancelled_at = now; row.cancellation_reason = body.cancellation_reason;
      }
      await onWrite?.(phase); if (lost === phase) throw new Error("synthetic lost class move leg");
      return method === "POST" ? Response.json(row, { status: 201 }) : new Response(null, { status: 204 });
    }
    if (/^\/v1\/attendees\/[1-9][0-9]*$/.test(url.pathname)) return Response.json(native.attendees.find(row => row.id === url.pathname.split("/").at(-1)));
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
  const permission: ClassMovePermission = { allows: async query => permitted && phasePermission(query.phase) };
  const config = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: source.policyVersion, ledger: f.ledger, policies: f.policies, verification: f.session,
    sourcePolicy, destinationPolicy, movePolicy, permission, cliniko: native.config, clock: () => now, signal: lifetime.signal, fetchPort };
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
    resultValue(await activeReception.selectReschedulingMenu(f.scope, turn("offer-one", "one"), "offers", 1, now)); await record("offerSelected");
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
    cliniko: { ...native.config, timeZone: source.timeZone, countryCallingCode: "61", recallTypeId: "7" }, signal: lifetime.signal, fetchPort, clock: () => now };
  return { ...f, classSessionConfig, bindNativeCall: (read: typeof callState) => { callState = read; }, native, host, reception, config, sourcePath, destinationPath, movePath, recalls, writes, steps, turn, play, verify, prepare,
    get claims() { return claims; }, get windowClaims() { return [...windows.values()]; }, pause, setTime: (value: string) => { now = value; f.setTime(value); }, permit: (value: boolean) => { permitted = value; },
    phasePermission: (allow: typeof phasePermission) => { phasePermission = allow; }, lose: (phase: NonNullable<typeof lost>) => { lost = phase; }, onWrite: (hook: typeof onWrite) => { onWrite = hook; },
    replaceSource: async (patch: Partial<ClassApproval>) => { source = { ...source, ...patch }; await writeFile(sourcePath, JSON.stringify(source)); },
    replaceDestination: async (patch: Partial<ClassApproval>) => { destination = { ...destination, ...patch }; await writeFile(destinationPath, JSON.stringify(destination)); },
    replaceMove: async (patch: Partial<ClassMoveApproval>) => { move = { ...move, ...patch }; await writeFile(movePath, JSON.stringify(move)); },
    close: async () => { lifetime.abort(); host.dispose(); await f.close(); } };
}
