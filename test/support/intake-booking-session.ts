import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoIntakeBookingSession } from "../../src/standalone/cliniko-intake-booking-session.ts";
import type { ClinikoIntakeBookingSessionConfig } from "../../src/standalone/cliniko-intake-booking-session.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { intakeSessionFixture } from "./intake-session.ts";
import { intakeCredential, intakeDraft, intakeNow } from "./intake-edge.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Provider state survives owner loss; no production account or email delivery. Also served over HTTP by the crash E2E. */
export function intakeBookingProvider() {
  const base = "https://api.au5.cliniko.com/v1", traffic: string[] = [], recalls: Record<string, unknown>[] = [];
  let patient: Record<string, unknown> | undefined, appointment: Record<string, unknown> | undefined;
  let patientPosts = 0, bookingPosts = 0, failure = "";
  let onRecall: () => Promise<void> = async () => undefined, onBook: () => Promise<void> = async () => undefined;
  let onContact: () => Promise<void> = async () => undefined;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    if (url.pathname === "/v1/patients" && method === "GET") return Response.json({ total_entries: 0, patients: [] });
    if (url.pathname === "/v1/patients" && method === "POST") {
      patientPosts++; patient = { ...JSON.parse(String(init?.body)), id: "42", archived_at: null, notes: "private intake booking provider notes" };
      if (failure === "intakeLoss") throw new Error("lost intake response"); return Response.json(patient, { status: 201 });
    }
    if (url.pathname === "/v1/patients/42") { await onContact(); return Response.json(patient); }
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true, archived_at: null, appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true, archived_at: null, display_name: "Demo Practitioner" });
    if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true, archived_at: null, duration_in_minutes: 30, name: "Physiotherapy" });
    if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (url.pathname.endsWith("/available_times")) return Response.json({ total_entries: failure === "slot" ? 0 : 2, available_times: failure === "slot" ? [] :
      [{ appointment_start: "2026-10-08T04:00:00.000Z" }, { appointment_start: "2026-10-08T05:00:00.000Z" }] });
    if (url.pathname === "/v1/recalls") {
      if (method === "GET") return Response.json({ total_entries: recalls.length, recalls });
      const body = JSON.parse(String(init?.body)); assert.equal(body.patient_id, "42");
      if (failure === "reviewRejected") return new Response(null, { status: 422 });
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `${base}/patients/42` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      recalls.push(row); await onRecall();
      if (failure === "reviewLoss") throw new Error("lost review response"); return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments" && method === "POST") {
      bookingPosts++; assert.equal(recalls.length, 1); const body = JSON.parse(String(init?.body)); assert.equal(body.patient_id, "42");
      if (failure === "bookingRejected") return new Response(null, { status: 422 });
      appointment = { id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: new Date(Date.parse(body.starts_at)+1_800_000).toISOString(),
        cancelled_at: null, archived_at: null, deleted_at: null, patient: { links: { self: `${base}/patients/42` } }, business: { links: { self: `${base}/businesses/11` } },
        practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      await onBook(); if (failure === "bookingLoss") throw new Error("lost booking response"); return Response.json(appointment, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments/91") return failure === "inspection" ? new Response(null, { status: 503 }) : Response.json(appointment);
    if (url.pathname === "/v1/individual_appointments/91/conflicts") return Response.json({ conflicts: { exist: failure === "conflict" } });
    throw new Error(`Unexpected synthetic path ${method} ${url.pathname}`);
  };
  return { fetchPort, traffic, recalls, get patient() { return patient; }, get appointment() { return appointment; },
    get patientPosts() { return patientPosts; }, get bookingPosts() { return bookingPosts; },
    fail: (value: string) => { failure = value; }, changePatient: (patch: Record<string, unknown>) => { patient = { ...patient, ...patch }; },
    onRecall: (run: () => Promise<void>) => { onRecall = run; }, onBook: (run: () => Promise<void>) => { onBook = run; }, onContact: (run: () => Promise<void>) => { onContact = run; } };
}

export async function intakeBookingSessionFixture(options: Parameters<typeof intakeSessionFixture>[0] = {}) {
  const provider = intakeBookingProvider();
  const f = await intakeSessionFixture({ ...options, bookingExecute: options.bookingExecute ?? true, fetchPort: options.fetchPort ?? provider.fetchPort });
  f.owner.dispose(); let owner: ClinikoIntakeBookingSession | undefined, permitted = true, now = intakeNow;
  let onPermission: () => Promise<void> = async () => undefined;
  const path = join(f.folder, "booking.json");
  let approval: BookingApproval = { scope: f.scope, revision: "new-patient-booking-1", approverRef: f.account.actor.actorRef,
    approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z",
    approved: true, enabled: true, policyVersion: "policy-1", businessId: "11", practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7",
    credentialFingerprint: clinikoCredentialFingerprint(intakeCredential), timeZone: "Australia/Sydney", writeContract: "bestEffort", notificationOwner: "cliniko",
    serviceRef: "physiotherapy", bookingPolicyVersion: "book-policy-1", durationMinutes: 30, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
  const replacePolicy = async (patch: Partial<BookingApproval>) => { approval = { ...approval, ...patch }; await writeFile(`${path}.new`, JSON.stringify(approval), { mode: 0o600 }); await rename(`${path}.new`, path); };
  try {
    await replacePolicy({});
    const config: ClinikoIntakeBookingSessionConfig = { ...f.config, ledger: f.ledger, policies: f.policies, directory: f.directory, bookingApprovalPath: path,
      bookingPermission: { allows: async (_scope, id, operation) => { assert.equal(id, "42"); assert.equal(operation, "appointments.book"); await onPermission(); return permitted; } },
      cliniko: { ...f.config.cliniko, businessId: "11", practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61" } };
    owner = resultValue(await ClinikoIntakeBookingSession.create(config));
    const reception = new TextReception(f.ledger, f.policies, owner), agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
    const turn = (turnId: string, text = "Book an appointment") => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, quality: "clear" as const, at: now });
    async function playPending() {
      const id = (await f.state()).pendingPresentationId; if (!id) return;
      resultValue(await f.runtime.startPresentation(f.callId, id, f.sessionId, now)); resultValue(await f.runtime.resolvePresentation(f.callId, id, "played", f.sessionId, now));
    }
    async function confirm(kind: "intake" | "book", played = true) {
      const action = Object.values((await f.state()).actions).find(action => action.kind === kind)!; assert.ok(action);
      if (played) await playPending(); return reception.affirm(f.scope, turn(`affirm-${kind}`, "Yes"), action.key, action.digest, now);
    }
    async function prepare() {
      const begin = resultValue(await owner!.intake.begin()); assert.equal(await owner!.intake.acknowledgeRecovery(begin.recoveryRef, true), true);
      const draft = resultValue(await owner!.intake.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true }));
      assert.equal((await owner!.intake.submitCode(f.mail.at(-1)!.code)).verified, true); return draft.draftRef;
    }
    const drain = () => reception.drain(f.scope, f.callId, now);
    const propose = (draftRef: string) => agent.submit({ kind: "patients.intake.propose.v1", turn: turn("intake"), draftRef, now });
    async function register() { const ref = await prepare(); resultValue(await propose(ref)); resultValue(await confirm("intake")); resultValue(await drain()); return ref; }
    return { ...f, owner, config, provider, reception, agent, turn, prepare, propose, register, confirm, playPending, drain, replacePolicy,
      readMenu: (turnId = "menu") => agent.submit({ kind: "booking.offers.read.v1", turn: turn(turnId), from: "2026-10-08", to: "2026-10-08", now }),
      select: (choice: 1|2|3 = 1, turnId = "select") => agent.submit({ kind: "booking.offers.select.v1", turn: turn(turnId), choice, now }),
      discover: () => resultValue(ClinikoRecallReader.create({ ...config.cliniko, scope: f.scope }, config.fetchPort)).discoverPendingReviews(f.scope, "7"),
      setPermitted: (value: boolean) => { permitted = value; }, onBookingPermission: (run: () => Promise<void>) => { onPermission = run; },
      setTime: (value: string) => { now = value; f.setTime(value); }, get now() { return now; }, close: async () => { owner?.dispose(); await f.close(); } };
  } catch (error) { owner?.dispose(); await f.close(); throw error; }
}

/** Scan every line and every long-value segment within the scanner's unchanged 256-byte interface. */
export function intakeBookingCanaries(values: readonly string[], prefix: string) {
  const parts = values.flatMap(value => value.split("\n").flatMap(line => {
    assert.ok(line.length >= 4);
    const chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += 240) chunks.push(line.slice(offset).length < 4 ? line.slice(-4) : line.slice(offset, offset+240));
    return chunks;
  }));
  return parts.map((value, index) => ({ label: `${prefix}_${index}`, value }));
}
