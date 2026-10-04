import assert from "node:assert/strict";
import test from "node:test";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-281 real email proof, current approved Cliniko offers and played SAM confirmation reach one reviewed inspected booking", async () => {
  const f = await bookingOffersFixture();
  try {
    const proof = await f.verify(), offered = resultValue(await f.list(proof)), choice = offered.choices[0]!;
    assert.equal(offered.choices.length, 3); assert.equal(offered.reservable, false);
    assert.deepEqual([offered.practitionerName, offered.appointmentTypeName, offered.serviceRef], ["Demo Practitioner", "Physiotherapy", "physiotherapy"]);
    assert.equal(choice.endsAt, "2026-10-08T04:30:00.000Z"); assert.equal(choice.expiresAt, "2026-10-04T06:02:00.000Z");
    assert.match(choice.offerRef, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(choice.offerRef, "selected-offer");
    const known = resultValue(await f.source.resolve(f.query(proof, choice.offerRef)));
    Object.assign(choice, { startsAt: "2026-10-08T05:00:00.000Z" }); // Caller-owned return is a copy, not host evidence.
    assert.equal(resultValue(await f.source.resolve(f.query(proof, choice.offerRef))).offer.startsAt, known.offer.startsAt);
    assert.ok((await f.propose(proof, "proposal", choice.offerRef)).ok); assert.ok((await f.confirm()).ok); await f.drain();
    const action = Object.values((await f.state()).actions)[0]!; assert.equal(action.status, "committed");
    assert.equal(f.posts, 1); assert.equal(f.recalls.length, 1); assert.equal(f.recalls[0]!.recalled, false);
    assert.equal(f.claims, f.allTraffic.length, "one mandatory API-user budget covers contact, availability, review and appointment requests");
    assert.ok(f.allTraffic.filter(value => value.endsWith("/available_times")).length >= 4, "fresh availability is required at proposal and final send gates");
    assert.equal(f.allTraffic.some(value => value.startsWith("PATCH") || value.startsWith("DELETE")), false);
  } finally { await f.close(); }
});

test("E2E-281 guessed, foreign, other-proof and expired selections cannot resolve; a new source cannot recover a call's offers", async () => {
  const f = await bookingOffersFixture({ offerTtlSeconds: 15 });
  try {
    const proof = await f.verify(), choice = resultValue(await f.list(proof)).choices[0]!, query = f.query(proof, choice.offerRef);
    for (const patch of [{ offerRef: "33" }, { offerRef: "selected-offer" }, { verificationRef: "guess" }, { patientId: "43" },
      { callId: "foreign" }, { sessionId: "foreign" }, { policyVersion: "foreign" }, { scope: { ...f.scope, clinicId: "foreign" } }, { phase: "other" }]) {
      const before = f.allTraffic.length;
      assert.equal((await f.source.resolve({ ...query, ...patch } as typeof query)).ok, false); assert.equal(f.allTraffic.length, before);
    }
    const fresh = f.freshSource();
    try { assert.equal((await fresh.resolve(query)).ok, false); } finally { fresh.dispose(); }
    f.setTime("2026-10-04T06:00:15.000Z");
    assert.ok((await f.session.proof.verifyOperation(f.scope, proof, "appointments.book", "2026-10-04T06:00:15.000Z")).ok, "the patient proof remains valid at offer expiry");
    assert.equal((await f.source.resolve({ ...query, now: "2026-10-04T06:00:15.000Z" })).ok, false);
  } finally { await f.close(); }
});

test("E2E-281 current provider duration, eligibility, relationships, labels, timezone and exact time are rechecked before booking", async () => {
  for (const failure of ["businessArchive", "businessOnline", "businessType", "practitionerArchive", "practitionerOnline", "inactive",
    "typeArchive", "typeOnline", "duration", "relationship", "typeRelationship", "zone", "practitionerName", "typeName", "server", "slotGone"]) {
    const f = await bookingOffersFixture();
    try {
      const proof = await f.verify(), choice = resultValue(await f.list(proof)).choices[0]!;
      assert.ok((await f.propose(proof, "proposal", choice.offerRef)).ok);
      f.setOnRecall(async () => { if (failure === "slotGone") f.setStarts([]); else f.setFailure(failure); });
      assert.ok((await f.confirm()).ok); await f.drain();
      assert.equal(f.posts, 0, failure); assert.equal(f.recalls.length, 1, failure);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed", failure);
    } finally { await f.close(); }
  }
});

test("E2E-281 patient/action permission and booking approval changes after listing or review cannot authorize a send", async () => {
  for (const phase of ["listing", "review"] as const) {
    for (const change of ["permission", "approved", "enabled", "member", "policy", "duration", "notice", "service", "contract", "notification"] as const) {
      const f = await bookingOffersFixture();
      try {
        const proof = await f.verify(), choice = resultValue(await f.list(proof)).choices[0]!;
        const revoke = async () => {
          if (change === "permission") f.setPermitted(false);
          if (change === "approved") await f.replacePolicy({ approved: false });
          if (change === "enabled") await f.replacePolicy({ enabled: false });
          if (change === "member") await f.replaceAccount([{ ...f.account, membershipVersion: "changed" }]);
          if (change === "policy") await f.replacePolicy({ bookingPolicyVersion: "changed" });
          if (change === "duration") await f.replacePolicy({ durationMinutes: 60 });
          if (change === "notice") await f.replacePolicy({ minNoticeMinutes: 120 });
          if (change === "service") await f.replacePolicy({ serviceRef: "changed" });
          if (change === "contract") await f.replacePolicy({ writeContract: "atomic" } as never);
          if (change === "notification") await f.replacePolicy({ notificationOwner: "abby" } as never);
        };
        if (phase === "listing") {
          await revoke(); assert.equal((await f.source.resolve(f.query(proof, choice.offerRef))).ok, false);
        } else {
          assert.ok((await f.propose(proof, "proposal", choice.offerRef)).ok); f.setOnRecall(revoke);
          assert.ok((await f.confirm()).ok); await f.drain();
        }
        assert.equal(f.posts, 0, `${phase}/${change}`);
      } finally { await f.close(); }
    }
  }
});

test("E2E-281 approved notice and horizon filter observed times; the Cliniko business calendar owns exact rechecks", async () => {
  const f = await bookingOffersFixture();
  try {
    const proof = await f.verify();
    f.setStarts(["2026-10-04T06:30:00.000Z", "2026-10-04T07:00:00.000Z"]);
    const today = resultValue(await f.list(proof, "2026-10-04", "2026-10-04"));
    assert.deepEqual(today.choices.map(choice => choice.startsAt), ["2026-10-04T07:00:00.000Z"]);
    f.setStarts(["2026-11-04T06:00:00.000Z"]); assert.deepEqual(resultValue(await f.list(proof, "2026-11-04", "2026-11-04")).choices, []);
    f.setStarts(["2026-10-07T13:30:00.000Z"]); // Sydney daylight saving: 00:30 on October 8.
    const local = resultValue(await f.list(proof)), choice = local.choices[0]!;
    assert.equal(resultValue(await f.source.resolve(f.query(proof, choice.offerRef))).offer.startsAt, choice.startsAt);
    assert.equal((await f.source.resolve({ ...f.query(proof, today.choices[0]!.offerRef), now: verificationNow })).ok, false, "new listing invalidates all old choices");
    assert.equal((await f.list(proof, "2026-02-30", "2026-03-01")).ok, false);
    assert.equal((await f.list(proof, "2026-10-04", "2026-10-12")).ok, false);
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-281 concurrent listings invalidate old work; query mutation cannot retarget an in-flight exact selection", async () => {
  const f = await bookingOffersFixture(); let release: () => void = () => undefined;
  try {
    const proof = await f.verify(); let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    f.setOnTimes(async () => { entered(); await held; }); const old = f.list(proof); await started;
    f.setOnTimes(async () => undefined); const fresh = resultValue(await f.list(proof)); release(); assert.equal((await old).ok, false);
    const chosen = fresh.choices[0]!, query = { ...f.query(proof, chosen.offerRef), scope: { ...f.scope } };
    let enteredRead: () => void = () => undefined, releaseRead: () => void = () => undefined;
    const reading = new Promise<void>(resolve => { enteredRead = resolve; }), wait = new Promise<void>(resolve => { releaseRead = resolve; });
    f.setOnTimes(async () => { enteredRead(); await wait; }); const resolving = f.source.resolve(query); await reading;
    Object.assign(query.scope, { clinicId: "retarget" }); query.offerRef = fresh.choices[1]!.offerRef; query.patientId = "other";
    releaseRead(); assert.equal(resultValue(await resolving).offer.offerRef, chosen.offerRef);
  } finally { release(); await f.close(); }
});

test("E2E-281 disposal and held budget timeout cannot publish late offers or make late provider requests", async () => {
  let block = false, release: () => void = () => undefined, entered: () => void = () => undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await bookingOffersFixture({ timeoutMs: 300, budget: { claim: async () => {
    if (block) { entered(); await new Promise<void>(resolve => { release = resolve; }); } return null;
  }, observe429: async () => ({ kind: "rateLimited" }) } });
  try {
    const proof = await f.verify(); block = true; const before = f.allTraffic.length;
    const listing = f.list(proof); await started; assert.equal((await listing).ok, false); release();
    await new Promise<void>(resolve => setTimeout(resolve, 15)); assert.equal(f.allTraffic.length, before);
    block = false; assert.equal((await f.list(proof)).ok, false, "a cancelled protected recheck revokes this proof");
    f.source.dispose(); assert.equal((await f.source.resolve(f.query(proof, "guess"))).ok, false);
    assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { release(); await f.close(); }
});

test("E2E-281 real listed offers cannot bypass automation/booking settings, emergency write stop or played confirmation", async () => {
  for (const change of ["automation", "booking", "stop", "unplayed"] as const) {
    const f = await bookingOffersFixture();
    try {
      const proof = await f.verify(), choice = resultValue(await f.list(proof)).choices[0]!;
      assert.ok((await f.propose(proof, "proposal", choice.offerRef)).ok);
      if (change === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
      if (change === "booking") assert.ok((await f.policies.changeBookingEnabled(f.scope, "1", false, "synthetic-admin")).ok);
      if (change === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
      await f.confirm(change !== "unplayed"); await f.drain();
      assert.equal(f.posts, 0, change); assert.equal(f.recalls.length, 0, change);
    } finally { await f.close(); }
  }
});


test("E2E-281 construction rejects another call or session's genuine verifier before any provider read", async () => {
  const f = await bookingOffersFixture();
  try {
    await f.verify(); const before = f.allTraffic.length;
    for (const patch of [{ callId: "different-call" }, { sessionId: "different-session" }]) {
      const source = f.createSource(patch);
      if (source.ok) source.value.dispose();
      assert.equal(source.ok, false);
    }
    assert.equal(f.allTraffic.length, before);
  } finally { await f.close(); }
});
