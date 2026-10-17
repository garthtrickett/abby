import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { ClinikoFinancialBookingCapture } from "../../src/cliniko/financial-booking-capture.ts";
import { ClinikoFinancialReviewReader } from "../../src/cliniko/financial-review-read.ts";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { fixture, intentValue, base, now, keys, keyRef, reviewDate, stop, value } from "../support/financial-retention.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });

async function prepared(kind: "book" | "classBook", options: { lostObservation?: boolean; prefill?: number } = {}) {
  const source = intentValue(), scope = { tenantId: `fr-${randomUUID()}`, clinicId: "clinic", locationId: "loc" };
  const intent = { ...source, scope, actionRef: randomUUID(), booking: { ...source.booking, actionRef: randomUUID(),
    ...(kind === "classBook" ? { kind, sessionId: "15" } : { kind }) },
    effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const budget = new ClinikoReadBudget(180, () => Date.parse(now));
  for (let i = 0; i < (options.prefill ?? 0); i++) assert.equal(await budget.claim(), null);
  const f = fixture({ intent, config: { rateBudget: budget },
    barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))),
    response: async (row, method) => {
      if (options.lostObservation && method === "POST" && String(row.notes).includes("financial booking observation")) throw new Error("synthetic lost retained observation response");
      return Response.json(row, { status: method === "POST" ? 201 : 200 });
    } });
  const retained = value(await f.retainer.retainIntentOnce(intent, reviewDate, stop()));
  assert.equal(retained.kind, "accepted"); if (retained.kind !== "accepted") throw new Error("Intent not retained");
  const binding = { recallRef: retained.recallRef, actionRef: intent.actionRef };
  const reader = value(ClinikoFinancialReviewReader.create(f.config, { allows: async () => true }, f.port));
  const capture = value(await ClinikoFinancialBookingCapture.prepare({ reader, privateKey: keys.privateKey, producerKeyRef: keyRef, clock: () => now }, binding, intent, stop()));
  const writes: string[] = [];
  const native: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/v1/individual_appointments" && path !== "/v1/attendees") return f.port(input, init);
    assert.equal(init?.method, "POST"); writes.push(path); const body = JSON.parse(String(init?.body));
    if (path === "/v1/attendees") return Response.json({ id: "92", links: { self: `${base}/attendees/92` },
      patient: { links: { self: `${base}/patients/${body.patient_id}` } }, booking: { links: { self: `${base}/bookings/${body.booking_id}` } },
      notes: body.notes, archived_at: null, deleted_at: null, cancelled_at: null }, { status: 201 });
    return Response.json({ id: "91", links: { self: `${base}/individual_appointments/91` }, notes: body.notes,
      patient: { links: { self: `${base}/patients/${body.patient_id}` } }, business: { links: { self: `${base}/businesses/11` } },
      practitioner: { links: { self: `${base}/practitioners/12` } }, appointment_type: { links: { self: `${base}/appointment_types/13` } },
      starts_at: body.starts_at, ends_at: body.ends_at, archived_at: null, deleted_at: null, cancelled_at: null }, { status: 201 });
  };
  const caller = new AbortController();
  const config = { ...f.config, practitionerId: "12", appointmentTypeId: "13" }, checks = { beforeSend: async () => true, current: () => true };
  const captured = kind === "book" ? value(await capture.book(value(ClinikoBookingWriter.create(config, native)),
    { scope, patientId: "21", marker: intent.booking.actionRef, startsAt: intent.booking.startsAt, endsAt: intent.booking.endsAt }, caller.signal, checks)) :
    value(await capture.classBook(value(ClinikoClassAttendanceWriter.create(config, native)),
      { kind: "book", scope, patientId: "21", sessionId: "15", actionId: intent.booking.actionRef }, caller.signal, checks));
  assert.ok(captured.native.ok); assert.equal(captured.native.value.kind, "accepted"); assert.equal(writes.length, 1);
  caller.abort(); // Subsequent retention belongs to the independent financial service.
  assert.equal(captured.observation.kind, "captured"); if (captured.observation.kind !== "captured") throw new Error("Native observation not captured");
  return { f, intent, binding, notes: captured.observation.notes, captured, writes, budget };
}

for (const kind of ["book", "classBook"] as const) test(`${kind}: provider-owned intent, actual native acknowledgement and retained observation survive a fresh financial owner`, async () => {
  const c = await prepared(kind), { f, intent } = c;
  const saved = value(await f.retainer.retainBookingObservationOnce(c.notes, { intent, intentRecallRef: c.binding.recallRef }, reviewDate, stop()));
  assert.equal(saved.kind, "accepted"); if (saved.kind !== "accepted") return;
  const coldBarrier = new PostgresFinancialEffectBarrier(db, intent.scope, value(financialRecordOwnerBinding(f.config)));
  const cold = value(ClinikoFinancialRecordRetainer.create(f.config, f.authority, coldBarrier, f.port));
  const context = value(await cold.readBookingObservation({ recallRef: saved.recallRef, actionRef: saved.actionRef, intentRecallRef: c.binding.recallRef }, intent, stop()));
  assert.equal(context.observation.targetRef, kind === "book" ? "cliniko:appointment:91" : "cliniko:attendee:92");
  assert.equal(context.observation.financialActionRef, intent.actionRef); assert.equal(Object.hasOwn(context, "paid"), false);
  assert.deepEqual(await cold.retainBookingObservationOnce(c.notes, { intent, intentRecallRef: c.binding.recallRef }, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${intent.scope.tenantId}`.execute(db)).rows;
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.effect_ref).sort(), [intent.actionRef, saved.actionRef].sort());
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
  assert.deepEqual(await scanPatientDataCanaries(db, [
    { label: "recipient", value: intent.recipient.address }, { label: "native_target", value: context.observation.targetRef },
    { label: "native_intent", value: c.binding.recallRef }, { label: "intent_body", value: "Abby financial intent v1" },
    { label: "observation_body", value: "Abby financial booking observation v1" },
  ]), { ok: true, value: [] });
  assert.equal(c.writes.length, 1);
});

test("lost financial retention response preserves acknowledged booking and durable Cliniko pending review without another POST", async () => {
  const c = await prepared("book", { lostObservation: true });
  assert.deepEqual(await c.f.retainer.retainBookingObservationOnce(c.notes, { intent: c.intent, intentRecallRef: c.binding.recallRef }, reviewDate, stop()),
    { ok: true, value: { kind: "uncertain" } });
  assert.ok(c.captured.native.ok); assert.equal(c.captured.native.value.kind, "accepted");
  assert.equal(c.f.rows.get("30")?.recalled, false); assert.equal(c.f.rows.size, 2);
  const cold = value(ClinikoFinancialRecordRetainer.create(c.f.config, c.f.authority,
    new PostgresFinancialEffectBarrier(db, c.intent.scope, value(financialRecordOwnerBinding(c.f.config))), c.f.port));
  assert.deepEqual(await cold.retainBookingObservationOnce(c.notes, { intent: c.intent, intentRecallRef: c.binding.recallRef }, reviewDate, stop()),
    { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(c.f.events.filter(e => e === "POST").length, 2); assert.equal(c.writes.length, 1);
});

test("the same180-request native account budget can exhaust after booking without erasing its acknowledgement or inventing retention", async () => {
  const c = await prepared("book", { prefill: 177 });
  const result = await c.f.retainer.retainBookingObservationOnce(c.notes, { intent: c.intent, intentRecallRef: c.binding.recallRef }, reviewDate, stop());
  assert.ok(!result.ok && result.error.kind === "rateLimited");
  assert.ok(c.captured.native.ok); assert.equal(c.captured.native.value.kind, "accepted"); assert.equal(c.writes.length, 1);
  assert.equal(c.f.rows.size, 1); assert.equal(c.f.events.filter(e => e === "POST").length, 1);
  assert.equal((await c.budget.claim())?.kind, "rateLimited");
});
