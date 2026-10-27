import assert from "node:assert/strict";
import test from "node:test";
import { bookingCatalogueFixture } from "../support/cliniko-booking-catalogue.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { bookingMenuPresentation } from "../../src/core/booking-menu.ts";
import type { BookingMenuRead } from "../../src/core/booking-menu.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { bookingPreferenceLanguage } from "../../src/standalone/booking-preference-language.ts";

async function fixture() {
  const f = await bookingCatalogueFixture();
  try {
    resultValue(await f.reception.startWorkflow(f.scope, f.turn("begin", "I need to book"), "book", verificationNow));
    assert.equal(f.flow.beginVerification(), true);
    await voiceUntil(() => f.mail.length === 1, "comparison verification challenge");
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    await f.playPending();
    const agent = new CommandGateway({ actorRef: "comparison-agent", role: "agent", scope: f.scope }, f.policies, f.reception);
    const read = async (id: string, practitioner: string, from = "2026-10-04", to = "2026-10-10") => {
      resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.turn(id, practitioner),
        from, to, preference: { practitioner }, now: verificationNow }));
      const state = await f.state(), notice = state.presentations[state.pendingPresentationId!];
      assert.ok(notice && "approvedText" in notice);
      return notice.approvedText;
    };
    const writes = () => f.traffic.filter(path => /^(POST|PATCH|DELETE) \/v1\/individual_appointments(?:\/|$)/.test(path));
    return { f, agent, read, writes };
  } catch (error) { await f.close(); throw error; }
}

test("R02 an earlier approved option keeps the original practitioner's exact availability visible", async () => {
  const { f, read, writes } = await fixture();
  try {
    const original = await read("original", "Demo A");
    assert.match(original, /with Demo A/); await f.playPending();
    const comparison = await read("compare", "any");
    assert.match(comparison, /original.*Physiotherapy.*Demo A.*Thursday 8 October.*30 minutes/s);
    assert.match(comparison, /earlier.*Demo B|Demo B.*earlier/s);
    assert.deepEqual(writes(), []);
  } finally { await f.close(); }
});

test("R02 returning to the original practitioner reads fresh times and writes only that exact choice", async () => {
  const { f, agent, read, writes } = await fixture();
  try {
    await read("original", "Demo A"); await f.playPending();
    await read("compare", "any"); await f.playPending();
    f.setStarts(["2026-10-09T04:00:00.000Z"]);
    const request = await f.flow.preferenceMenuIntent("Can I go back to my original practitioner?");
    assert.ok(request?.kind === "bookingMenu");
    assert.deepEqual(request.preference, { practitioner: "Demo A" });
    const returned = await read("return", request.preference!.practitioner!, request.from, request.to);
    assert.match(returned, /Physiotherapy with Demo A.*Friday 9 October/s);
    assert.doesNotMatch(returned, /Thursday 8 October|with Demo B/);
    assert.deepEqual(writes(), []); await f.playPending();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.turn("select", "Option one"), choice: 1, now: verificationNow }));
    const action = Object.values((await f.state()).actions).at(-1)!;
    assert.equal(action.mutation.request.kind, "book");
    if (action.mutation.request.kind !== "book") throw new Error("expected original booking");
    assert.equal(action.mutation.request.offer.startsAt, "2026-10-09T04:00:00.000Z");
    assert.equal(action.mutation.request.offer.presentation?.practitionerName, "Demo A");
    assert.equal(f.recalls.length, 0); assert.deepEqual(writes(), []); await f.playPending();
    resultValue(await f.reception.affirm(f.scope, f.turn("confirm", "Yes"), action.key, action.digest, verificationNow));
    resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
    assert.deepEqual(writes(), ["POST /v1/individual_appointments"]);
    assert.equal((await f.state()).actions[action.key]?.status, "committed");
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "book");
    if (review.request.operation.kind === "book") {
      assert.equal(review.request.operation.practitionerId, "22");
      assert.equal(review.request.operation.startsAt, "2026-10-09T04:00:00.000Z");
    }
    resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
    assert.deepEqual(writes(), ["POST /v1/individual_appointments"]);
  } finally { await f.close(); }
});

test("R02 an unavailable original read cannot become an empty or completed comparison", async () => {
  const { f, read, writes } = await fixture();
  try {
    await read("original", "Demo A"); await f.playPending(); f.setFailure("server");
    const failed = await read("compare", "any");
    assert.doesNotMatch(failed, /original choice|earlier eligible|couldn't find|option one/);
    assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.recalls.length, 0); assert.deepEqual(writes(), []);
  } finally { await f.close(); }
});

test("R02 complete empty original and out-of-day alternatives keep their exact search bounds", async () => {
  const { f, read, writes } = await fixture();
  try {
    f.setStarts([]);
    const comparison = await read("compare", "any");
    assert.match(comparison, /original choice, Physiotherapy with Demo A.*couldn't find an eligible start in these searched dates/s);
    assert.match(comparison, /with Demo B.*Wednesday 7 October/s); await f.playPending();
    f.setAlternateStarts(["2026-10-09T04:00:00.000Z"]);
    const empty = await read("requested-day", "any", "2026-10-08", "2026-10-08");
    assert.match(empty, /Thursday 8 October.*couldn't find/s);
    assert.doesNotMatch(empty, /Friday 9 October|option one|earlier eligible|fully booked/);
    assert.equal(f.recalls.length, 0); assert.deepEqual(writes(), []);
  } finally { await f.close(); }
});

test("R02 an unplayed comparison or withdrawn alternative cannot authorize a booking", async () => {
  for (const stage of ["unplayed", "withdrawn"] as const) {
    const { f, agent, read, writes } = await fixture();
    try {
      await read("compare", "any");
      if (stage === "withdrawn") await f.playPending();
      await agent.submit({ kind: "booking.offers.select.v1", turn: f.turn("select", "Option one"), choice: 1, now: verificationNow });
      if (stage === "withdrawn") {
        const action = Object.values((await f.state()).actions).at(-1)!;
        assert.ok(action); await f.playPending(); await f.revokeAlternate();
        resultValue(await f.reception.affirm(f.scope, f.turn("confirm", "Yes"), action.key, action.digest, verificationNow));
        resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
        assert.equal((await f.state()).actions[action.key]?.status, "rejected");
      } else assert.equal(Object.keys((await f.state()).actions).length, 0);
      assert.equal(f.recalls.length, 0); assert.deepEqual(writes(), []);
    } finally { await f.close(); }
  }
});

test("R02 comparison evidence validates both subjects, exact services, durations, dates and original freshness", () => {
  const binding = { scope: { tenantId: "tenant", clinicId: "clinic", locationId: "main" }, callId: "call", sessionId: "session", policyVersion: "policy" };
  const original: NonNullable<BookingMenuRead["comparison"]>["original"] = { ...binding, observedAt: verificationNow,
    timeZone: "Australia/Sydney", practitionerName: "Demo A", appointmentTypeName: "Physiotherapy", reservable: false, locationName: "North",
    searchScope: { locationName: "North", practitioners: ["Demo A"], from: "2026-10-04", to: "2026-10-10", selection: "preferred" },
    choices: [{ startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T05:00:00.000Z", expiresAt: "2026-10-04T06:04:00.000Z" }] };
  const read: BookingMenuRead = { ...original, practitionerName: "Demo B", searchScope: { ...original.searchScope!, practitioners: ["Demo A", "Demo B"], selection: "earliestApproved" },
    choices: [{ startsAt: "2026-10-07T04:00:00.000Z", endsAt: "2026-10-07T04:30:00.000Z", expiresAt: "2026-10-04T06:04:00.000Z" }], comparison: { original } };
  const valid = resultValue(bookingMenuPresentation(read, binding, verificationNow));
  assert.match(valid, /Demo A.*60 minutes.*Demo B.*30 minutes/s);
  const invalidOriginals = [
    { ...original, scope: { ...binding.scope, tenantId: "foreign" } },
    { ...original, appointmentTypeName: "Massage" },
    { ...original, observedAt: "2026-10-04T05:59:00.000Z" },
    { ...original, choices: [{ ...original.choices[0]!, endsAt: original.choices[0]!.startsAt }] },
    { ...original, choices: [{ ...original.choices[0]!, expiresAt: verificationNow }] },
    { ...original, choices: [{ ...original.choices[0]!, startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T05:00:00.000Z" }] },
    { ...original, choices: null },
    { ...original, comparison: { original } },
    { ...original, searchScope: { ...original.searchScope!, from: "2026-10-05" } },
    { ...original, window: { startMinute: 0, endMinute: 1440, startInclusive: true } },
  ];
  for (const invalid of invalidOriginals) assert.equal(bookingMenuPresentation({ ...read, comparison: { original: invalid } } as BookingMenuRead, binding, verificationNow).ok, false);
  assert.equal(bookingMenuPresentation({ ...read, choices: [{ ...original.choices[0]!, startsAt: "2026-10-09T04:00:00.000Z", endsAt: "2026-10-09T05:00:00.000Z" }] }, binding, verificationNow).ok, false);
});

test("R02 equal earliest starts retain approved member ordering and an empty comparison remains empty", async () => {
  for (const empty of [false, true]) {
    const { f, read, writes } = await fixture();
    try {
      f.setAlternateStarts(empty ? [] : ["2026-10-08T04:00:00.000Z"]);
      if (empty) f.setStarts([]);
      await read("original", "Demo B"); await f.playPending();
      const comparison = await read("compare", "any");
      if (empty) {
        assert.match(comparison, /couldn't find an eligible booking time/);
        assert.doesNotMatch(comparison, /option one|original choice|earlier eligible/);
      } else {
        assert.match(comparison, /These options are with Demo A/);
        assert.match(comparison, /original choice.*Demo B.*Demo A has an eligible start at the same time/s);
        assert.doesNotMatch(comparison, /has an earlier eligible start/);
      }
      await f.playPending();
      const request = await f.flow.preferenceMenuIntent("Check my original practitioner again.");
      assert.ok(request?.kind === "bookingMenu"); assert.deepEqual(request.preference, { practitioner: "Demo B" });
      assert.deepEqual(writes(), []);
    } finally { await f.close(); }
  }
});

test("R02 only explicit original-practitioner requests use the remembered public choice", () => {
  for (const text of ["Can I go back to my original practitioner?", "Please check the original practitioner again.", "See my original practitioner, please."])
    assert.deepEqual(bookingPreferenceLanguage(text), { kind: "originalPractitioner" });
  for (const text of ["Don't go back to my original practitioner.", "Someone said check my original practitioner.", "Go back to my original practitioner or Demo B."])
    assert.equal(bookingPreferenceLanguage(text), undefined);
});
