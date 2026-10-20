// E2E-421: original-patient signed follow-up booking with actual private financial consent; synthetic remote grants and speech.
import assert from "node:assert/strict";
import test from "node:test";
import { financialCall, selectBooking, playTerms, until } from "../support/outbound-follow-up-financial.ts";
import { keys, keyRef, value } from "../support/financial-retention.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";

test("signed outbound follow-up uses actual private payment readback and consent before a separately played clinical booking", { timeout: 45000 }, async t => {
  const c = await financialCall(); t.after(c.close); const f = c.f;
  const { code, input } = await selectBooking(c);
  const before = f.sent.filter(x => x.event === "mark").length;
  await f.privateKey("1"); assert.equal(f.sent.filter(x => x.event === "mark").length, before);
  assert.equal(input.inputAdmission()?.phase, "unplayed"); assert.equal(input.readySelection, undefined);
  await f.mark(); await playTerms(c);
  await f.privateKey("1"); await until(() => input.readySelection !== undefined, "separate payment consent"); await f.privateQuiet();
  await f.say("continue booking", { kind: "clarify" }); assert.equal(c.seen.includes("continue booking"), false); await f.mark();
  assert.equal(Object.values((await f.current()).actions)[0]!.status, "awaitingConfirmation");
  await f.say("Yes", { kind: "affirm" }); assert.equal(f.bookings, 1); assert.equal(c.policyCalls, 1);
  assert.equal(Object.values((await f.current()).actions)[0]!.status, "committed");
  const nativeIntent = [...c.funding.rows.values()].find(row => String(row.notes).includes("financial intent")); assert.ok(nativeIntent);
  const intent = value(decodeClinikoFinancialIntent(nativeIntent.notes));
  const observed = [...c.funding.rows.values()].find(row => String(row.notes).includes("financial booking observation")); assert.ok(observed);
  const proof = value(verifyFinancialBookingObservation(observed.notes, { intent, intentRecallRef: `cliniko:recall:${nativeIntent.id}`, producerKeyRef: keyRef, publicKey: keys.publicKey }));
  assert.equal(proof.targetRef, "cliniko:appointment:91"); assert.ok(proof.financialConsent);
  for (const secret of [code, verificationCanaries[0]!, "GBP 50.00"])
    assert.equal(JSON.stringify([c.seen, f.transcripts, await f.current()]).includes(secret), false);
  assert.equal(f.patches, 0); assert.ok(c.claims <= 180);
});

for (const digit of ["2", "*"])
test(`signed follow-up can decline private financial terms with ${digit} and creates no clinical action`, { timeout: 45000 }, async t => {
  const c = await financialCall(); t.after(c.close); const { input } = await selectBooking(c);
  await c.f.mark(); await playTerms(c); await c.f.privateKey(digit);
  await until(() => !input.inputActive, "actual declined private input");
  assert.equal(input.readySelection, undefined); assert.equal(c.f.bookings, 0);
  assert.equal(Object.keys((await c.f.current()).actions).length, 0);
  assert.equal([...c.funding.rows.values()].some(row => String(row.notes).includes("financial booking observation")), false);
});

test("signed follow-up financial approval withdrawal prevents the next private segment", { timeout: 45000 }, async t => {
  const c = await financialCall(); t.after(c.close); const { input } = await selectBooking(c);
  await c.f.mark(); const spoken = c.f.spoken.length; c.grants.live = false;
  await c.f.privateKey("1"); await until(() => !input.inputActive, "withdrawn financial approval");
  assert.equal(c.f.spoken.length, spoken); assert.equal(input.readySelection, undefined);
  assert.equal(c.f.bookings, 0); assert.equal(Object.keys((await c.f.current()).actions).length, 0);
});

for (const changed of ["original", "contact", "approval", "financial"] as const)
test(`signed follow-up accepted payment terms grant no booking after late ${changed} change`, { timeout: 45000 }, async t => {
  const c = await financialCall(); t.after(c.close); const { input } = await selectBooking(c);
  await c.f.mark(); await playTerms(c); await c.f.privateKey("1");
  await until(() => input.readySelection !== undefined, "separate payment consent"); await c.f.privateQuiet();
  await c.f.say("continue booking", { kind: "clarify" }); await c.f.mark();
  assert.equal(Object.values((await c.f.current()).actions)[0]!.status, "awaitingConfirmation");
  if (changed === "original") c.f.changeRequest(); else if (changed === "contact") c.f.changeContact();
  else if (changed === "approval") c.f.state.originalLive = false; else c.grants.live = false;
  await c.f.say("Yes", { kind: "affirm" }); assert.equal(c.f.bookings, 0);
  assert.notEqual(Object.values((await c.f.current()).actions)[0]!.status, "committed");
  assert.equal(c.f.nativeCalls.some(call => call.method === "POST" && call.path === "/v1/individual_appointments"), false);
});

test("signed outgoing follow-up selects an approved public service and exact duration before private financial consent", { timeout: 45000 }, async t => {
  const c = await financialCall({ services: true }); t.after(c.close);
  const { input } = await selectBooking(c, "Book a sixty-minute initial Physiotherapy appointment.");
  assert.equal(c.seen.includes("Book a sixty-minute initial Physiotherapy appointment."), false);
  await c.f.mark(); await playTerms(c); await c.f.privateKey("1");
  await until(() => input.readySelection !== undefined, "public-service financial consent"); await c.f.privateQuiet();
  await c.f.say("continue booking", { kind: "clarify" }); await c.f.mark();
  const action = Object.values((await c.f.current()).actions)[0]!;
  assert.equal(action.kind, "book"); assert.equal(action.mutation.request.kind, "book");
  if (action.mutation.request.kind !== "book") throw Error("Expected selected public service");
  assert.equal(action.mutation.request.offer.presentation?.durationMinutes, 60);
  assert.match(c.f.spoken.at(-1)!, /Physiotherapy initial.*60 minutes/);
  await c.f.say("Yes", { kind: "affirm" }); assert.equal(c.f.bookings, 1);
  const intentRow = [...c.funding.rows.values()].find(row => String(row.notes).includes("financial intent")); assert.ok(intentRow);
  assert.equal(value(decodeClinikoFinancialIntent(intentRow.notes)).booking.appointmentTypeId, "34");
  assert.equal(Object.values((await c.f.current()).actions)[0]!.status, "committed"); assert.ok(c.claims <= 180);
});
