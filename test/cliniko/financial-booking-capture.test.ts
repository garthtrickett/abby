import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { ClinikoFinancialBookingCapture } from "../../src/cliniko/financial-booking-capture.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import { ClinikoFinancialReviewReader } from "../../src/cliniko/financial-review-read.ts";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" };
const apiKey = "synthetic-financial-au5", base = "https://api.au5.cliniko.com/v1";
const now = "2026-11-01T10:00:00.000Z", binding = { recallRef: "cliniko:recall:30", actionRef: uuid(1) };
const keys = generateKeyPairSync("ed25519"), keyRef = "booking-owner-fixture-1";
const permit = { beforeSend: async () => true, current: () => true };
const signal = () => new AbortController().signal;
function value<T extends { ok: true; value: unknown } | { ok: false; error: unknown }>(result: T): Extract<T, { ok: true }>["value"] {
  assert.ok(result.ok); return result.value as Extract<T, { ok: true }>["value"];
}
function fixture(kind: "book" | "classBook" = "book") {
  const intent: ClinikoFinancialIntent = {
    actionRef: uuid(1), scope, patientId: "21", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
    booking: { actionRef: uuid(2), practitionerId: "12", appointmentTypeId: "13",
      startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T09:30:00.000Z", ...(kind === "classBook" ? { kind, sessionId: "15" } : { kind }) },
    stripe: { accountRef: "acct_fixture", livemode: false },
    payment: { amount: 5000, currency: "gbp", policyVersion: "fees-1", termsVersion: "terms-1", deadline: "2026-11-02T08:00:00.000Z" },
    recipient: { kind: "email", address: "private-finance@example.invalid" },
    effects: { checkout: uuid(3), linkDelivery: uuid(4), receiptDelivery: uuid(5), checkoutExpiry: uuid(6), clinicalExpiry: uuid(7) }, createdAt: "2026-11-01T09:00:00.000Z",
  };
  const events: string[] = [];
  const budget = { claim: async () => { events.push("quota"); return null; }, observe429: async () => ({ kind: "rateLimited" as const }) };
  const config = { scope, apiKey, contactEmail: "clinic@example.invalid", businessId: "11", practitionerId: "12", appointmentTypeId: "13", rateBudget: budget };
  let allowed = true, archived = false, recalled = false, lost = false, malformed = false, nominal = false, afterAck = false;
  const nativeReview = () => ({ id: "30", links: { self: `${base}/recalls/30` }, patient: { links: { self: `${base}/patients/21` } },
    recall_type: { links: { self: `${base}/recall_types/40` } }, notes: value(encodeClinikoFinancialIntent(intent)),
    recall_at: "2026-11-02", recalled, archived_at: archived ? now : null, created_at: intent.createdAt, updated_at: now });
  const reader = value(ClinikoFinancialReviewReader.create({ ...config, recallTypeId: "40", stripe: intent.stripe, clock: () => now },
    { allows: async () => allowed }, async (_url, init) => { events.push(init?.method ?? "GET"); return Response.json(nativeReview()); }));
  const response = () => kind === "book" ? {
    id: "91", notes: `Abby booking ${intent.booking.actionRef}`, starts_at: intent.booking.startsAt, ends_at: intent.booking.endsAt,
    cancelled_at: null, archived_at: null, deleted_at: null,
    patient: { links: { self: `${base}/patients/${malformed ? "999" : "21"}` } }, business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/12` } }, appointment_type: { links: { self: `${base}/appointment_types/13` } },
  } : { id: "92", links: { self: `${base}/attendees/92` }, patient: { links: { self: `${base}/patients/${malformed ? "999" : "21"}` } },
    booking: { links: { self: `${base}/bookings/15` } }, notes: `Abby attendance ${intent.booking.actionRef}`,
    cancelled_at: null, archived_at: null, deleted_at: null };
  const port: typeof fetch = async (_url, init) => {
    events.push(init?.method ?? "GET");
    if (lost) throw new Error("private upstream canary");
    return Response.json(response(), { status: 201 });
  };
  const writer = value(ClinikoBookingWriter.create(config, port)), classWriter = value(ClinikoClassAttendanceWriter.create(config, port));
  const original = writer.writeOnce.bind(writer), originalClass = classWriter.executeBookingOnce.bind(classWriter);
  writer.writeOnce = async (...args) => { if (nominal) return { ok: true, value: { kind: "accepted", appointmentRef: "cliniko:appointment:91" } };
    const result = await original(...args); if (afterAck) throw new Error("private after-ack canary"); return result; };
  classWriter.executeBookingOnce = async (...args) => { if (nominal) return { ok: true, value: { kind: "accepted", attendeeRef: "cliniko:attendee:92" } };
    const result = await originalClass(...args); if (afterAck) throw new Error("private after-ack canary"); return result; };
  const prepare = (clock = () => now, expected = intent) => ClinikoFinancialBookingCapture.prepare({ reader, privateKey: keys.privateKey, producerKeyRef: keyRef, clock }, binding, expected, signal());
  const run = (capture: ClinikoFinancialBookingCapture, checks = permit) => kind === "book"
    ? capture.book(writer, { scope, patientId: "21", startsAt: intent.booking.startsAt, endsAt: intent.booking.endsAt, marker: intent.booking.actionRef }, signal(), checks)
    : capture.classBook(classWriter, { kind: "book", scope, patientId: "21", sessionId: "15", actionId: intent.booking.actionRef }, signal(), checks);
  return { intent, reader, writer, classWriter, config, events, prepare, run,
    deny: () => { allowed = false; }, archive: () => { archived = true; }, recall: () => { recalled = true; },
    lose: () => { lost = true; }, malformed: () => { malformed = true; }, nominal: () => { nominal = true; }, afterAck: () => { afterAck = true; } };
}
function verified(notes: string, intent: ClinikoFinancialIntent, publicKey = keys.publicKey) {
  return verifyFinancialBookingObservation(notes, { intent, intentRecallRef: binding.recallRef, producerKeyRef: keyRef, publicKey });
}

for (const kind of ["book", "classBook"] as const) {
  test(`${kind}: actual validated native callback captures a verifiable exact producer observation`, async () => {
    const f = fixture(kind), prepared = value(await f.prepare());
    const result = value(await f.run(prepared));
    assert.ok(result.native.ok); assert.equal(result.native.value.kind, "accepted");
    assert.equal(result.observation.kind, "captured");
    if (result.observation.kind !== "captured") return;
    const observed = value(verified(result.observation.notes, f.intent));
    assert.equal(observed.bookingActionRef, f.intent.booking.actionRef);
    assert.deepEqual(observed.classCreationRequest, kind === "classBook" ? { sessionId: "15" } : undefined);
    assert.equal(observed.targetRef, kind === "book" ? "cliniko:appointment:91" : "cliniko:attendee:92");
    assert.deepEqual(f.events, ["quota", "GET", "quota", "POST"]);
    assert.equal(JSON.stringify(prepared), "{}"); assert.equal(Object.isFrozen(observed), true);
    for (const canary of ["private-finance@", apiKey, "5000", "paid"]) assert.equal(result.observation.notes.includes(canary), false);
    assert.equal((await f.run(prepared)).ok, false); assert.equal(f.events.filter(e => e === "POST").length, 1);
  });
  for (const failure of ["lose", "malformed", "nominal"] as const) test(`${kind}: ${failure} cannot manufacture an observed acknowledgement`, async () => {
    const f = fixture(kind), prepared = value(await f.prepare()); f[failure]();
    const result = value(await f.run(prepared)); assert.equal(result.observation.kind, "missing");
    if (failure === "nominal") { assert.ok(result.native.ok); assert.equal(result.native.value.kind, "accepted"); }
    else { assert.ok(result.native.ok); assert.equal(result.native.value.kind, "uncertain"); }
  });
  test(`${kind}: optional signing failure and later wrapper error preserve the observed native booking`, async () => {
    for (const badClock of [false, true]) {
      const f = fixture(kind), prepared = value(await f.prepare(badClock ? () => { throw new Error("private clock canary"); } : () => now));
      f.afterAck(); const result = value(await f.run(prepared));
      assert.ok(result.native.ok); assert.equal(result.native.value.kind, "accepted");
      assert.equal(result.observation.kind, badClock ? "missing" : "captured");
      assert.equal(JSON.stringify(result).includes("canary"), false);
    }
  });
  test(`${kind}: final native permission is still mandatory and failure never produces a financial observation`, async () => {
    const f = fixture(kind), prepared = value(await f.prepare());
    const result = value(await f.run(prepared, { beforeSend: async () => false, current: () => true }));
    assert.equal(result.native.ok, false); assert.equal(result.observation.kind, "missing"); assert.equal(f.events.includes("POST"), false);
  });
}

test("preparation refuses denied, archived, recalled, changed-fee and invalid-key context before any booking", async () => {
  for (const state of ["deny", "archive", "recall", "changed"] as const) {
    const f = fixture(); if (state !== "changed") f[state]();
    const expected = state === "changed" ? { ...f.intent, payment: { ...f.intent.payment, amount: 6000 } } : f.intent;
    assert.equal((await f.prepare(() => now, expected)).ok, false); assert.equal(f.events.includes("POST"), false);
  }
  const f = fixture();
  assert.equal((await ClinikoFinancialBookingCapture.prepare({ reader: f.reader, privateKey: keys.publicKey, producerKeyRef: keyRef }, binding, f.intent, signal())).ok, false);
  assert.equal(f.events.length, 0);
});

test("native marker, patient, selection and credential mismatches refuse before a native write", async () => {
  for (const change of ["marker", "patient", "credential", "selection"] as const) {
    const f = fixture(), prepared = value(await f.prepare());
    const writer = value(ClinikoBookingWriter.create({ ...f.config, ...(change === "credential" ? { apiKey: "other-au5" } : {}),
      ...(change === "selection" ? { practitionerId: "99" } : {}) }, async () => { assert.fail("Unexpected native write"); }));
    const result = await prepared.book(writer, { scope, patientId: change === "patient" ? "99" : "21", marker: change === "marker" ? uuid(9) : f.intent.booking.actionRef,
      startsAt: f.intent.booking.startsAt, endsAt: f.intent.booking.endsAt }, signal(), permit);
    assert.equal(result.ok, false); assert.equal(f.events.includes("POST"), false);
  }
});

test("verification refuses edited fields, replay across intents/records, wrong trust, wrong family and malformed notes", async () => {
  const f = fixture(), result = value(await f.run(value(await f.prepare())));
  assert.equal(result.observation.kind, "captured"); if (result.observation.kind !== "captured") return;
  const notes = result.observation.notes;
  const otherKey = generateKeyPairSync("ed25519").publicKey;
  assert.equal(verified(notes, f.intent, otherKey).ok, false);
  const changes: ClinikoFinancialIntent[] = [
    { ...f.intent, scope: { ...scope, locationId: "other" } }, { ...f.intent, payment: { ...f.intent.payment, amount: 1 } },
    { ...f.intent, recipient: { kind: "email", address: "other@example.invalid" } },
    { ...f.intent, stripe: { ...f.intent.stripe, livemode: true } }, { ...f.intent, effects: { ...f.intent.effects, checkout: uuid(10) } },
  ];
  for (const intent of changes) assert.equal(verified(notes, intent).ok, false);
  for (const edited of [notes + "\n", notes.replace("appointment:91", "appointment:99"), notes.replace("financial booking observation", "financial intent"),
    notes.replace("Abby request ", "Abby request wrong"), notes.replace("2026-11-01T10", "2026-11-01T11"), notes.replace(keyRef, "other-owner"),
    value(encodeClinikoFinancialIntent(f.intent)), "x".repeat(1051)]) assert.equal(verified(edited, f.intent).ok, false);
  assert.equal(verifyFinancialBookingObservation(notes, { intent: f.intent, intentRecallRef: "cliniko:recall:31", producerKeyRef: keyRef, publicKey: keys.publicKey }).ok, false);
});
