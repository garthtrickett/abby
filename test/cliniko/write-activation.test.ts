import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { ClinikoPatientIntakeEdge, clinikoIntakeDraftDigest } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeAuthority, ClinikoIntakeRequest } from "../../src/cliniko/patient-intake.ts";

const scope = { tenantId: "activation", clinicId: "clinic", locationId: "main" };
const base = "https://api.au5.cliniko.com/v1";
const now = "2026-10-03T10:00:00.000Z";
const startsAt = "2026-10-08T04:00:00Z", endsAt = "2026-10-08T04:30:00Z";
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11" };
const target = { scope, patientId: "42", appointmentId: "91", practitionerId: "22", appointmentTypeId: "33", startsAt, endsAt };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { kind: string } }): T {
  if (!result.ok) assert.fail(result.error.kind);
  return result.value;
}
function appointment(id: string, start = startsAt, end = endsAt) {
  return { id, starts_at: start, ends_at: end, cancelled_at: null as string | null,
    archived_at: null, deleted_at: null, notes: "Private activation note",
    patient: { links: { self: `${base}/patients/42` } },
    business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/22` } },
    appointment_type: { links: { self: `${base}/appointment_types/33` } } };
}
/** Hold both observations/sends until each independent writer has reached this phase. */
function rendezvous() {
  let arrived = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => { if (++arrived === 2) release(); await ready; };
}

test("E2E-264 cancellation pre-read cannot prevent another writer moving the target before PATCH", async () => {
  const row = appointment("91");
  let patches = 0;
  const provider: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") return Response.json(row);
    assert.equal(init?.method, "PATCH"); patches += 1;
    // A different actor changes the appointment after Abby's read has completed.
    row.starts_at = "2026-10-09T04:00:00Z"; row.ends_at = "2026-10-09T04:30:00Z";
    row.cancelled_at = now;
    return new Response(null, { status: 204 });
  };
  const writer = value(ClinikoCancellationWriter.create(config, provider, () => now));
  assert.deepEqual(value(await writer.cancelOnce({ ...target, cancellationReason: 50 })), { kind: "uncertain" });
  assert.equal(patches, 1);
  assert.equal(row.cancelled_at, now, "uncertain wording does not undo the wrong-time cancellation");
  assert.equal(row.starts_at, "2026-10-09T04:00:00Z");
  assert.equal(value(await writer.observe({ ...target, cancellationReason: 50 })).kind, "changed");
});

test("E2E-264 independent cancellation writers can both send after observing the same active target", { timeout: 5_000 }, async () => {
  const observed = rendezvous();
  let cancelled = false, patches = 0;
  const provider: typeof fetch = async (_input, init) => {
    if (init?.method === "PATCH") { patches += 1; cancelled = true; return new Response(null, { status: 204 }); }
    const snapshot = { ...appointment("91"), cancelled_at: cancelled ? now : null };
    if (!cancelled) await observed();
    return Response.json(snapshot);
  };
  const writers = [0, 1].map(() => value(ClinikoCancellationWriter.create(config, provider, () => now)));
  const results = await Promise.all(writers.map(writer => writer.cancelOnce({ ...target, cancellationReason: 50 })));
  assert.deepEqual(results.map(value), [{ kind: "cancelled" }, { kind: "cancelled" }]);
  assert.equal(patches, 2, "writer-instance fences do not provide cross-writer exclusion");
});

test("E2E-264 independent booking writers can create the same slot with distinct request markers", async () => {
  const rows: ReturnType<typeof appointment>[] = [];
  const provider: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init.body)) as { starts_at: string; notes: string };
    const row = { ...appointment(String(91 + rows.length), body.starts_at), notes: body.notes };
    rows.push(row); return Response.json(row, { status: 201 });
  };
  const markers = ["7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1", "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd2"];
  const results = await Promise.all(markers.map(marker =>
    value(ClinikoBookingWriter.create({ ...config, practitionerId: "22", appointmentTypeId: "33" }, provider, () => now))
      .writeOnce({ scope, patientId: "42", startsAt, marker })));
  assert.ok(results.every(result => result.ok && result.value.kind === "accepted"));
  assert.equal(rows.length, 2); assert.equal(rows[0]?.starts_at, rows[1]?.starts_at);
  assert.notEqual(rows[0]?.id, rows[1]?.id);
});

test("E2E-264 two in-place moves can conflict before the post-write conflict check observes it", { timeout: 5_000 }, async () => {
  const rows = new Map([["91", appointment("91")], ["92", appointment("92", "2026-10-08T06:00:00Z", "2026-10-08T06:30:00Z")]]);
  const sent = rendezvous();
  let patches = 0;
  const newStartsAt = "2026-10-08T05:00:00Z", newEndsAt = "2026-10-08T05:30:00Z";
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conflicts")) {
      const current = rows.get(url.pathname.split("/").at(-2)!); assert.ok(current);
      const exist = [...rows.values()].some(other => other.id !== current.id &&
        Date.parse(other.starts_at) < Date.parse(current.ends_at) && Date.parse(other.ends_at) > Date.parse(current.starts_at));
      return Response.json({ conflicts: { exist } });
    }
    const id = url.pathname.split("/").at(-1)!; const row = rows.get(id)!; assert.ok(row);
    if (init?.method === "PATCH") {
      patches += 1; row.starts_at = newStartsAt; row.ends_at = newEndsAt;
      await sent(); return Response.json(row);
    }
    return Response.json(row);
  };
  const results = await Promise.all([...rows.values()].map(row =>
    value(ClinikoRescheduleWriter.create(config, provider, () => now)).rescheduleOnce({ ...target,
      appointmentId: row.id, startsAt: row.starts_at, endsAt: row.ends_at, newStartsAt, newEndsAt })));
  assert.deepEqual(results.map(value), [{ kind: "movedWithConflict" }, { kind: "movedWithConflict" }]);
  assert.equal(patches, 2); assert.equal(rows.get("91")?.starts_at, rows.get("92")?.starts_at);
});

test("E2E-264 separate intake authorities can both create after observing no duplicate patient", { timeout: 5_000 }, async () => {
  const searched = rendezvous(); let posts = 0;
  const draft: ClinikoIntakeRequest = { scope, callId: "call:one", sessionId: "session:one", attemptRef: "intake:one",
    policyVersion: "intake-policy:1", firstName: "First", lastName: "Patient", email: "patient@example.test",
    dateOfBirth: "1990-05-21", patientPhone: "0400 111 222", phoneType: "Mobile", caller: "patient",
    consentRef: "host:consent:one", authorityRef: "host:authority:one" };
  const provider: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") { await searched(); return Response.json({ total_entries: 0, patients: [] }); }
    assert.equal(init?.method, "POST"); posts += 1;
    return Response.json({ id: String(41 + posts), first_name: draft.firstName, last_name: draft.lastName,
      email: draft.email, date_of_birth: draft.dateOfBirth, accepted_privacy_policy: true, archived_at: null }, { status: 201 });
  };
  const results = await Promise.all([0, 1].map(index => {
    const input = { ...draft, callId: `call:${index}`, sessionId: `session:${index}`, attemptRef: `intake:${index}` };
    const authority: ClinikoIntakeAuthority = { attest: async request => ({ scope, callId: request.callId,
      sessionId: request.sessionId, attemptRef: request.attemptRef, policyVersion: request.policyVersion,
      draftDigest: clinikoIntakeDraftDigest(request), caller: request.caller, consentRef: request.consentRef,
      authorityRef: request.authorityRef, privacyAccepted: true, proxyAuthorized: false, expiresAt: "2026-10-03T10:05:00.000Z" }) };
    return value(ClinikoPatientIntakeEdge.create(config, authority, provider, () => now)).createOnce(input);
  }));
  assert.ok(results.every(result => result.ok && result.value.kind === "created"));
  assert.equal(posts, 2);
  const first = value(results[0]!), second = value(results[1]!);
  assert.ok(first.kind === "created" && second.kind === "created");
  assert.notEqual(first.patientRef, second.patientRef);
});

test("E2E-264 a recall marker cannot fence independent writer instances", async () => {
  const clinicScope = { tenantId: scope.tenantId, clinicId: scope.clinicId }; let posts = 0;
  const provider: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST"); posts += 1;
    const body = JSON.parse(String(init.body)) as { notes: string; recall_at: string };
    return Response.json({ id: String(posts), notes: body.notes, recall_at: body.recall_at, recalled: false,
      archived_at: null, patient: { links: { self: `${base}/patients/42` } },
      recall_type: { links: { self: `${base}/recall_types/7` } } }, { status: 201 });
  };
  const request = { scope: clinicScope, patientId: "42", recallTypeId: "7", recallAt: "2026-10-08",
    marker: "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1", summary: "Synthetic callback request" };
  const results = await Promise.all([0, 1].map(() =>
    value(ClinikoRecallWriter.create({ ...config, scope: clinicScope }, provider)).openOnce(request)));
  assert.ok(results.every(result => result.ok && result.value.kind === "accepted"));
  assert.equal(posts, 2);
});
