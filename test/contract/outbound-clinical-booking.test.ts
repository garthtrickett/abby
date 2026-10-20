// E2E-421: original-patient signed follow-up booking with actual private financial consent; synthetic remote grants and speech.
import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoBookingSession } from "../../src/standalone/cliniko-booking-session.ts";
import type { ClinikoBookingSessionConfig } from "../../src/standalone/cliniko-booking-session.ts";
import { outboundClinicalBookingFixture } from "../support/outbound-clinical-booking.ts";
import { value } from "../support/outbound-records.ts";

test("actual original follow-up booking uses independent verification, played options/review and one acknowledged native interval", async t => {
  const f = await outboundClinicalBookingFixture(); t.after(f.close);
  assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  assert.equal((await f.owner.offers.list(f.scope, "unverified", "2026-10-08", "2026-10-08", "2026-10-04T06:00:00.000Z")).ok, false);
  await f.verify(); value(await f.read()); await f.play(); value(await f.select());
  assert.equal(f.posts, 0); value(await f.confirm()); value(await f.drain());
  assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.ok(f.claims <= 180); assert.ok(f.claims >= f.nativeCalls.length);
  const index = f.nativeCalls.findIndex(call => call.method === "POST" && call.path === "/v1/individual_appointments");
  assert.ok(index > 0); assert.ok(f.nativeCalls[index - 1]!.path.endsWith("/available_times"), "Only local fences follow final availability");
});

for (const failure of ["original", "contact", "grant"] as const)
test(`outgoing follow-up ${failure} withdrawal after played choice cannot dispatch`, async t => {
  const f = await outboundClinicalBookingFixture(); t.after(f.close);
  await f.verify(); value(await f.read()); await f.play(); value(await f.select()); await f.play();
  if (failure === "original") f.editOriginal(); else if (failure === "contact") f.changeContact(); else f.grants.original = false;
  const action = Object.values((await f.state()).actions)[0]!;
  value(await f.reception.affirm(f.scope, f.turn("confirm", "Yes"), action.key, action.digest, "2026-10-04T06:00:00.000Z"));
  await f.drain(); assert.equal(f.posts, 0); assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
});

test("native original edit before protected offers returns no menu", async t => {
  const f = await outboundClinicalBookingFixture(); t.after(f.close); await f.verify(); f.editOriginal();
  const before = f.nativeCalls.length; value(await f.read());
  assert.ok(f.nativeCalls.slice(before).some(call => call.path === "/v1/recalls/30"));
  assert.equal(Object.keys((await f.state()).actions).length, 0);
  const shown = (await f.state()).presentations[(await f.state()).pendingPresentationId!];
  assert.ok(shown && shown.kind !== "transfer");
  assert.doesNotMatch(shown.approvedText, /option one|Physiotherapy with/);
  assert.equal(f.nativeCalls.slice(before).some(call => call.path.endsWith("/available_times")), false); assert.equal(f.posts, 0);
});

test("incoming and outgoing booking constructors cannot disguise admission or add representative authority", async t => {
  const f = await outboundClinicalBookingFixture(); t.after(f.close);
  assert.equal((await ClinikoBookingSession.create(f.config as unknown as ClinikoBookingSessionConfig)).ok, false);
  assert.equal((await ClinikoBookingSession.createOutbound({ ...f.config, inbound: undefined } as unknown as typeof f.config)).ok, false);
  assert.equal((await ClinikoBookingSession.createOutbound({ ...f.config, representative: undefined } as unknown as typeof f.config)).ok, false);
  assert.equal((await ClinikoBookingSession.createOutbound({ ...f.config, cliniko: { ...f.config.cliniko, apiKey: "other-au5" } })).ok, false);
  assert.equal(f.mail.length, 0);
});

test("follow-up original approval withdrawn during a native availability wait cannot publish a clinical write", async t => {
  const f = await outboundClinicalBookingFixture(); t.after(f.close); await f.verify();
  value(await f.read()); await f.play(); value(await f.select()); value(await f.confirm());
  f.setOnTimes(async () => { f.grants.original = false; });
  await f.drain(); assert.equal(f.posts, 0); assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
});
