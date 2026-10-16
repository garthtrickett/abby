import assert from "node:assert/strict";
import test from "node:test";
import { classCancellationFixture } from "../support/class-cancellation.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
test("E2E-393 class cancellation uses distinct operation proof, played class and fee confirmation, owned review and one exact attendance PATCH", async () => {
  const f = await classCancellationFixture();
  try {
    const originalClasses = structuredClone(f.native.groups), other = structuredClone(f.native.attendees.filter(row => row.id !== "101"));
    await f.verify();
    const action = await f.propose();
    const presentation = (await f.state()).presentations[action.presentationId]!;
    assert.ok(presentation.kind === "speech");
    assert.match(presentation.approvedText, /Mat Pilates/);
    assert.match(presentation.approvedText, /No cancellation fee/);
    assert.equal((await f.state()).policy.bookingEnabled, false, "booking permission is not required for a cancellation");
    assert.equal(f.writes.length, 0);
    assert.equal(f.recalls.length, 0);
    resultValue(await f.confirm());
    resultValue(await f.drain());
    assert.equal((await f.state()).actions[action.key]!.status, "committed");
    assert.equal(f.writes.length, 1);
    assert.equal(f.recalls.length, 1);
    assert.ok(f.claims <= 200);
    assert.deepEqual(f.native.groups, originalClasses);
    assert.deepEqual(f.native.attendees.filter(row => row.id !== "101"), other);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "classCancel");
    if (review.request.operation.kind !== "classCancel")
      assert.fail("wrong class review");
    assert.deepEqual([review.request.operation.sessionId, review.request.operation.attendeeId], ["91", "101"]);
    assert.equal((await f.discovery()).pending.length, 1);
  }
  finally {
    await f.close();
  }
});
for (const fault of ["classPermission", "callerPermission", "terms", "classPolicy", "member", "target", "nativeType", "stop", "closed"] as const)
  test(`E2E-393 current class cancellation ${fault} after review denies the attendance PATCH`, async () => {
    const f = await classCancellationFixture();
    try {
      await f.verify();
      const action = await f.propose();
      resultValue(await f.confirm());
      f.onRecall(async () => {
        if (fault === "classPermission")
          f.permission(false);
        if (fault === "callerPermission")
          f.setPermitted(false);
        if (fault === "terms")
          await f.replaceCancellation({ standardTerms: { version: "changed-standard", approvedText: "Different fee applies." } });
        if (fault === "classPolicy")
          await f.replacePolicy({ enabled: false });
        if (fault === "member")
          await f.replaceAccount({ membershipVersion: "changed" });
        if (fault === "target")
          f.native.attendees.find(row => row.id === "101")!.cancelled_at = "2026-10-04T06:00:00.000Z";
        if (fault === "nativeType")
          f.native.groups[0]!.appointment_type = { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/34" } };
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
  test(`E2E-393 unknown class cancellation ${lost} response never replays or becomes a later exact commit`, async () => {
    const f = await classCancellationFixture();
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
      assert.deepEqual((await f.state()).actions[action.key], retained);
      assert.equal(f.writes.length, lost === "review" ? 0 : 1);
      assert.equal((await f.discovery()).pending.length, 1);
    }
    finally {
      await f.close();
    }
  });
for (const fault of ["permission", "anotherOwnAttendance", "targetPatient"] as const)
  test(`E2E-393 ${fault} after cancellation dispatch prevents success disclosure`, async () => {
    const f = await classCancellationFixture();
    try {
      await f.verify();
      const action = await f.propose();
      resultValue(await f.confirm());
      f.onWrite(async () => {
        if (fault === "permission")
          f.setPermitted(false);
        if (fault === "targetPatient")
          f.native.attendees.find(row => row.id === "101")!.patient = { links: { self: "https://api.au5.cliniko.com/v1/patients/99" } };
        if (fault === "anotherOwnAttendance")
          f.native.attendees.push({ id: "402", links: { self: "https://api.au5.cliniko.com/v1/attendees/402" }, booking: { links: { self: "https://api.au5.cliniko.com/v1/bookings/91" } }, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/482746192837465" } }, archived_at: null, deleted_at: null, cancelled_at: null });
      });
      resultValue(await f.drain());
      assert.equal(f.writes.length, 1);
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
      resultValue(await f.drain());
      assert.equal(f.writes.length, 1);
    }
    finally {
      await f.close();
    }
  });
test("E2E-393 unplayed class cancellation consent cannot send and cancellation proof cannot book", async () => {
  const f = await classCancellationFixture();
  try {
    await f.verify();
    const grant = await f.session.verified();
    assert.ok(grant);
    assert.equal((await f.session.proof.verifyOperation(f.scope, grant.verificationRef, "appointments.book", "2026-10-04T06:00:00.000Z")).ok, false);
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
test("E2E-393 duplicate own attendance is ambiguous and cannot become a partial public class list", async () => {
  const f = await classCancellationFixture();
  try {
    await f.verify();
    const grant = await f.session.verified();
    assert.ok(grant);
    f.native.attendees.push({ id: "402", links: { self: "https://api.au5.cliniko.com/v1/attendees/402" }, booking: { links: { self: "https://api.au5.cliniko.com/v1/bookings/91" } }, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/482746192837465" } }, archived_at: null, deleted_at: null, cancelled_at: null });
    assert.equal((await f.host.list(f.scope, grant.verificationRef, "2026-10-04T06:00:00.000Z", "2026-10-09T10:00:00.000Z", "2026-10-04T06:00:00.000Z")).ok, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.recalls.length, 0);
  }
  finally {
    await f.close();
  }
});
test("E2E-393 independent class denial prevents public listing even with an issued cancellation code", async () => {
  const f = await classCancellationFixture();
  try {
    await f.verify();
    const grant = await f.session.verified();
    assert.ok(grant);
    f.permission(false);
    assert.equal((await f.host.list(f.scope, grant.verificationRef, "2026-10-04T06:00:00.000Z", "2026-10-09T10:00:00.000Z", "2026-10-04T06:00:00.000Z")).ok, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.recalls.length, 0);
  }
  finally {
    await f.close();
  }
});
test("E2E-393 private cancellation target and native class notes do not enter caller messages or proposal results", async () => {
  const f = await classCancellationFixture();
  try {
    await f.verify();
    const action = await f.propose();
    const publicText = (await f.state()).callerMessages.join("\n");
    for (const secret of [f.mail[0]!.code, f.mail[0]!.email, "482746192837465", "private-class-shared-note", "private-attendee-note", "private-other-name", "class-target:"])
      assert.equal(publicText.includes(secret), false);
    const premature = await f.host.write(action.mutation, "2026-10-04T06:00:00.000Z");
    assert.equal(premature.kind, "rejected");
    assert.equal(f.recalls.length, 0);
    assert.equal(f.writes.length, 0);
  }
  finally {
    await f.close();
  }
});

test("E2E-393 a real booking-only channel proof cannot read or cancel class attendance", async () => {
  const f = await classCancellationFixture({ operation: "appointments.book" });
  try {
    await f.verify(); const grant = await f.session.verified(); assert.ok(grant);
    assert.equal((await f.host.list(f.scope,grant.verificationRef,"2026-10-04T06:00:00.000Z","2026-10-09T10:00:00.000Z","2026-10-04T06:00:00.000Z")).ok,false);
    assert.equal(f.native.traffic.length,0);assert.equal(f.recalls.length,0);assert.equal(f.writes.length,0);
  } finally { await f.close(); }
});

test("E2E-393 crossing the approved late-notice boundary invalidates already confirmed class fees",async()=>{
  const f=await classCancellationFixture();
  try{
    f.native.groups[0]!.starts_at="2026-10-05T06:00:00.050Z";f.native.groups[0]!.ends_at="2026-10-05T07:00:00.050Z";
    await f.verify();const action=await f.propose();const before=(await f.state()).presentations[action.presentationId]!;assert.ok(before.kind==="speech");assert.match(before.approvedText,/No cancellation fee/);
    resultValue(await f.confirm());f.onRecall(async()=>{f.setTime("2026-10-04T06:00:00.100Z");});
    await f.drain();assert.equal(f.recalls.length,1);assert.equal(f.writes.length,0);assert.notEqual((await f.state()).actions[action.key]!.status,"committed");
  }finally{await f.close();}
});

test("E2E-393 several class attendances require a played explicit choice and cancel only the chosen attendance",async()=>{
  const f=await classCancellationFixture();
  try{
    f.native.groups[3]!.starts_at="2026-10-08T11:30:00.000Z";f.native.groups[3]!.ends_at="2026-10-08T12:30:00.000Z";
    f.native.attendees.push({id:"402",links:{self:"https://api.au5.cliniko.com/v1/attendees/402"},booking:{links:{self:"https://api.au5.cliniko.com/v1/bookings/94"}},patient:{links:{self:"https://api.au5.cliniko.com/v1/patients/482746192837465"}},archived_at:null,deleted_at:null,cancelled_at:null});
    await f.verify();const grant=await f.session.verified();assert.ok(grant);const now="2026-10-04T06:00:00.000Z";
    resultValue(await f.agent.submit({kind:"appointments.read.v1",turn:f.turn("multiple"),verificationRef:grant.verificationRef,from:now,to:"2026-10-09T10:00:00.000Z",now}));
    assert.equal((await f.state()).appointmentReads.at(-1)!.shownCount,2);
    assert.equal((await f.host.resolveAppointmentChange({kind:"cancel",scope:f.scope,callId:f.callId,sessionId:f.sessionId,policyVersion:f.sessionConfig.policyVersion,verificationRef:grant.verificationRef,targetRef:"selected",now})).ok,false);
    await f.play();resultValue(await f.reception.selectAppointment(f.scope,f.turn("second","Second option"),grant.verificationRef,2,now));await f.play();
    resultValue(await f.agent.submit({kind:"appointments.change.propose.v1",turn:f.turn("chosen-cancel"),selection:{kind:"cancel",verificationRef:grant.verificationRef,targetRef:"selected"},now}));
    const action=Object.values((await f.state()).actions).at(-1)!;assert.equal(action.status,"awaitingConfirmation");
    resultValue(await f.confirm());resultValue(await f.drain());assert.equal((await f.state()).actions[action.key]!.status,"committed");assert.ok(f.claims<=200);
    assert.equal(f.native.attendees.find(row=>row.id==="101")!.cancelled_at,null);assert.equal(f.native.attendees.find(row=>row.id==="402")!.cancelled_at,now);
    const review=resultValue(decodeClinikoReview(f.recalls[0]!.notes));assert.equal(review.request.operation.kind,"classCancel");
    if(review.request.operation.kind!=="classCancel")assert.fail("wrong class review");assert.equal(review.request.operation.attendeeId,"402");assert.equal(review.request.operation.sessionId,"94");
  }finally{await f.close();}
});
