import assert from "node:assert/strict";
import test from "node:test";
import { classBookingFixture } from "../support/class-booking.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
test("E2E-392 class booking uses actual channel proof, played class terms and separate SAM affirmation before reviewed native attendance", async () => {
  const f = await classBookingFixture();
  try {
    await f.verify();
    const action = await f.propose();
    assert.equal(f.writes.length, 0);
    assert.equal(f.recalls.length, 0);
    const presentation = (await f.state()).presentations[action.presentationId]!;
    assert.ok(presentation.kind === "speech");
    assert.match(presentation.approvedText, /Mat Pilates/);
    assert.match(presentation.approvedText, /12 pounds/);
    resultValue(await f.confirm());
    resultValue(await f.drain());
    assert.equal((await f.state()).actions[action.key]!.status, "committed");
    assert.equal(f.writes.length, 1);
    assert.equal(f.recalls.length, 1);
    assert.ok(f.claims <= 200);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "classBook");
    if (review.request.operation.kind !== "classBook")
      assert.fail("wrong class review");
    assert.equal(review.request.operation.sessionId, "94");
    assert.equal(f.writes[0]!.booking_id, "94");
    assert.equal(f.writes[0]!.notes, `Abby attendance ${review.request.operation.attendanceActionId}`);
    assert.equal((await f.discovery()).pending.length, 1);
  }
  finally {
    await f.close();
  }
});
for (const fault of ["permission", "callerPermission", "terms", "member", "capacity", "nativeType", "stop", "closed"] as const)
  test(`E2E-392 class ${fault} changing after consent and review blocks attendee sending`, async () => {
    const f = await classBookingFixture();
    try {
      await f.verify();
      const action = await f.propose();
      resultValue(await f.confirm());
      f.onRecall(async () => {
        if (fault === "permission")
          f.permission(false);
        if (fault === "callerPermission")
          f.setPermitted(false);
        if (fault === "terms")
          await f.replacePolicy({ bookingTerms: { version: "class-terms-2", approvedText: "Changed class terms." } });
        if (fault === "member")
          await f.replaceAccount({ membershipVersion: "changed" });
        if (fault === "capacity")
          for (let i = 0; i < 3; i++)
            f.native.attendees.push({ id: String(701 + i), links: { self: `https://api.au5.cliniko.com/v1/attendees/${701 + i}` }, booking: { links: { self: "https://api.au5.cliniko.com/v1/bookings/94" } }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${901 + i}` } }, archived_at: null, deleted_at: null, cancelled_at: null });
        if (fault === "nativeType")
          f.native.groups[3]!.appointment_type = { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/34" } };
        if (fault === "stop")
          resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
        if (fault === "closed")
          f.host.dispose();
      });
      resultValue(await f.drain());
      assert.equal(f.recalls.length, 1);
      assert.equal(f.writes.length, 0);
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
    }
    finally {
      await f.close();
    }
  });
for (const lost of ["review", "write"] as const)
  test(`E2E-392 lost class ${lost} response remains uncertain without replay or later upgrade`, async () => {
    const f = await classBookingFixture();
    try {
      await f.verify();
      const action = await f.propose();
      resultValue(await f.confirm());
      if (lost === "review")
        f.loseReview();
      else
        f.loseWrite();
      resultValue(await f.drain());
      const retained = (await f.state()).actions[action.key]!;
      assert.ok(["uncertain", "needsReview"].includes(retained.status));
      assert.equal(f.recalls.length, 1);
      assert.equal(f.writes.length, lost === "review" ? 0 : 1);
      assert.deepEqual(await f.host.reconcile(retained.mutation), { kind: "stillUnknown", actionKey: action.key });
      resultValue(await f.drain());
      assert.equal(f.writes.length, lost === "review" ? 0 : 1);
      assert.deepEqual((await f.state()).actions[action.key], retained);
      assert.equal((await f.discovery()).pending.length, 1);
    }
    finally {
      await f.close();
    }
  });
for (const race of ["overCapacity", "duplicateOwn", "permission"] as const)
  test(`E2E-392 native ${race} after attendee create cannot produce a caller confirmation`, async () => {
    const f = await classBookingFixture();
    try {
      await f.verify();
      const action = await f.propose();
      resultValue(await f.confirm());
      f.onWrite(async () => {
        if (race === "permission") {
          f.setPermitted(false);
          return;
        }
        const count = race === "duplicateOwn" ? 1 : 3;
        for (let i = 0; i < count; i++)
          f.native.attendees.push({ id: String(701 + i), links: { self: `https://api.au5.cliniko.com/v1/attendees/${701 + i}` }, booking: { links: { self: "https://api.au5.cliniko.com/v1/bookings/94" } }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${race === "duplicateOwn" ? f.writes[0]!.patient_id : 901 + i}` } }, archived_at: null, deleted_at: null, cancelled_at: null });
      });
      resultValue(await f.drain());
      assert.equal(f.writes.length, 1);
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.recalls.length, 1);
      assert.equal((await f.discovery()).pending.length, 1);
      resultValue(await f.drain());
      assert.equal(f.writes.length, 1);
    }
    finally {
      await f.close();
    }
  });
test("E2E-392 an unplayed class consent cannot send a review or create attendance", async () => {
  const f = await classBookingFixture();
  try {
    await f.verify();
    await f.propose();
    await f.confirm(false);
    await f.drain();
    assert.equal(f.recalls.length, 0);
    assert.equal(f.writes.length, 0);
  }
  finally {
    await f.close();
  }
});
test("E2E-392 private fields and native choice identifiers stay outside caller presentations", async () => {
  const f = await classBookingFixture();
  try {
    await f.verify();
    await f.propose();
    const publicText = (await f.state()).callerMessages.join("\n");
    for (const secret of [f.mail[0]!.email, f.mail[0]!.code, "482746192837465", "private-class-shared-note", "private-attendee-note", "private-other-name", "class-offer:", "private-class-proof"])
      assert.equal(publicText.includes(secret), false);
    assert.equal(f.recalls.length, 0);
    assert.equal(f.writes.length, 0);
  }
  finally {
    await f.close();
  }
});

test("E2E-392 a foreign current policy snapshot cannot authorize a class menu or review", async () => {
  const f = await classBookingFixture();
  try {
    await f.verify();
    const read = f.policies.read.bind(f.policies);
    f.policies.read = async scope => {
      const found = await read(scope);
      return found.ok ? { ok: true, value: { ...found.value, scope: { ...scope, locationId: "foreign" } } } : found;
    };
    const turn = f.turn("foreign", "Show classes");
    assert.equal((await f.host.readBookingMenu({scope:f.scope,callId:f.callId,sessionId:f.sessionId,policyVersion:f.sessionConfig.policyVersion,turnId:turn.turnId,
      from:"2026-10-08",to:"2026-10-08",now:"2026-10-04T06:00:00.000Z",signal:new AbortController().signal})).ok,false);
    const declined = resultValue(await f.reception.readBookingMenu(f.scope, turn, "2026-10-08", "2026-10-08", "2026-10-04T06:00:00.000Z"));
    assert.match(declined.callerMessages.at(-1)!, /can't check/);
    assert.equal(Object.keys(declined.actions).length, 0);
    assert.equal(f.native.traffic.length, 0); assert.equal(f.recalls.length, 0); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("E2E-392 an arbitrary issued-looking offer and premature mutation have no SAM class authority", async () => {
  const f = await classBookingFixture();
  try {
    await f.verify();
    const grant = await f.session.verified(); assert.ok(grant);
    assert.equal((await f.host.resolveBooking(f.scope, grant.verificationRef, "class-offer:00000000-0000-4000-8000-000000000001", "2026-10-04T06:00:00.000Z")).ok, false);
    const action = await f.propose();
    assert.equal((await f.host.write(action.mutation, "2026-10-04T06:00:00.000Z")).kind, "rejected");
    assert.equal(f.recalls.length, 0); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
