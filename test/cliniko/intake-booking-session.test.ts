import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoIntakeBookingSession } from "../../src/standalone/cliniko-intake-booking-session.ts";
import { intakeBookingSessionFixture } from "../support/intake-booking-session.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-296 one admitted caller privately registers then separately selects, confirms and creates one reviewed booking", async () => {
  const f = await intakeBookingSessionFixture();
  try {
    const ref = await f.register(); const source = await f.owner.intake.createdPatient(); assert.ok(source);
    assert.equal(source.patientId, "42"); assert.equal(f.provider.patientPosts, 1); assert.equal(f.provider.bookingPosts, 0); assert.equal(f.provider.recalls.length, 0);
    await f.playPending(); const menu = resultValue(await f.readMenu());
    const notice = (await f.state()).presentations[(await f.state()).pendingPresentationId!]!;
    assert.equal(notice.kind, "notice"); if (notice.kind === "notice") assert.match(notice.approvedText, /option one.*option two/);
    await f.playPending(); const selected = resultValue(await f.select(2));
    const book = Object.values((await f.state()).actions).find(action => action.kind === "book")!; assert.ok(book);
    assert.equal(book.status, "awaitingConfirmation"); assert.equal(f.provider.bookingPosts, 0);
    const speech = (await f.state()).presentations[book.presentationId]!;
    assert.equal(speech.kind, "speech"); if (speech.kind === "speech") assert.match(speech.approvedText, /Physiotherapy.*Demo Practitioner.*30 minutes/);
    assert.equal(book.mutation.request.kind, "book");
    if (book.mutation.request.kind === "book") {
      assert.equal(book.mutation.request.patient.expiresAt, source.expiresAt, "booking grant cannot extend mailbox proof expiry");
      assert.equal(book.mutation.request.offer.startsAt, "2026-10-08T05:00:00.000Z");
      for (const secret of [ref, f.mail[0]!.code, intakeDraft.email, intakeDraft.dateOfBirth, book.mutation.request.patient.verificationRef, book.mutation.request.offer.offerRef])
        assert.equal(JSON.stringify([menu, selected]).includes(secret), false);
    }
    resultValue(await f.confirm("book")); resultValue(await f.drain());
    const state = await f.state(); assert.equal(Object.values(state.actions).find(action => action.kind === "intake")!.status, "committed");
    assert.equal(state.actions[book.key]!.status, "committed"); assert.equal(f.provider.patientPosts, 1); assert.equal(f.provider.bookingPosts, 1);
    assert.equal(f.provider.recalls.length, 1); assert.equal(f.provider.recalls[0]!.recalled, false); assert.equal(f.mail.length, 1);
    const sequence = f.provider.traffic.filter(text => text.startsWith("POST"));
    assert.deepEqual(sequence, ["POST /v1/patients", "POST /v1/recalls", "POST /v1/individual_appointments"]);
    resultValue(await f.drain()); assert.equal(f.provider.bookingPosts, 1);
  } finally { await f.close(); }
});

test("E2E-296 creation alone, an uncertain receipt or a fresh owner cannot issue appointment permission", async () => {
  for (const cause of ["before", "permission", "intakeLoss", "fresh"] as const) {
    const f = await intakeBookingSessionFixture(); let replacement: ClinikoIntakeBookingSession | undefined;
    try {
      if (cause === "intakeLoss") f.provider.fail("intakeLoss");
      if (cause !== "before") { await f.register(); await f.playPending(); }
      if (cause === "permission") f.setPermitted(false);
      if (cause === "fresh") {
        const result = await ClinikoIntakeBookingSession.create(f.config);
        if (result.ok) { replacement = result.value; assert.equal(await replacement.intake.createdPatient(), undefined); }
        else assert.equal(result.error.kind, "intakeBookingSessionUnavailable");
        f.owner.dispose();
      }
      await f.readMenu(); resultValue(await f.drain());
      assert.equal(Object.values((await f.state()).actions).filter(action => action.kind === "book").length, 0);
      assert.equal(f.provider.bookingPosts, 0); assert.equal(f.provider.recalls.length, 0);
      assert.equal(f.provider.patientPosts, cause === "before" ? 0 : 1);
    } finally { replacement?.dispose(); await f.close(); }
  }
});

test("E2E-296 independent permission, original OTP expiry, contact, public approval, settings and owner loss revoke downstream booking", async () => {
  for (const cause of ["permission", "email", "phone", "archived", "expiry", "approval", "intakeApproval", "member", "booking", "stop", "close"] as const) {
    const f = await intakeBookingSessionFixture();
    try {
      await f.register(); await f.playPending(); resultValue(await f.readMenu()); await f.playPending();
      if (cause === "permission") f.setPermitted(false);
      if (cause === "email") f.provider.changePatient({ email: "different@example.test" });
      if (cause === "phone") f.provider.changePatient({ patient_phone_numbers: [{ number: "+61400999888", phone_type: "Mobile" }] });
      if (cause === "archived") f.provider.changePatient({ archived_at: f.now });
      if (cause === "expiry") { for (let seconds = 20; seconds <= 180; seconds += 20) {
        f.setTime(new Date(Date.parse("2026-10-04T12:00:00.000Z")+seconds*1000).toISOString());
        resultValue(await f.runtime.renewSession(f.callId, f.sessionId, (await f.state()).sessionLease!.version, f.now));
      } }
      if (cause === "approval") await f.replacePolicy({ enabled: false });
      if (cause === "intakeApproval") await f.replaceApproval({ enabled: false });
      if (cause === "member") await f.replaceAccount({ membershipVersion: "changed" });
      if (cause === "booking") f.changeCurrent({ bookingEnabled: false });
      if (cause === "stop") resultValue(await f.ledger.stopWrites(f.scope, "intake-admin", "stop"));
      if (cause === "close") f.owner.dispose();
      await f.select(); resultValue(await f.drain());
      assert.equal(f.provider.bookingPosts, 0, cause); assert.equal(f.provider.recalls.length, 0, cause);
      assert.equal(f.provider.patientPosts, 1); assert.ok(f.provider.patient);
      assert.equal(Object.values((await f.state()).actions).filter(action => action.kind === "book").length, 0, cause);
    } finally { await f.close(); }
  }
});

test("E2E-296 rejected booking, failed review and lost responses retain the created patient and never replay, compensate or claim an exact appointment", async () => {
  for (const cause of ["slot", "bookingRejected", "reviewRejected", "reviewLoss", "bookingLoss", "inspection", "conflict"] as const) {
    const f = await intakeBookingSessionFixture();
    try {
      await f.register(); await f.playPending(); resultValue(await f.readMenu()); await f.playPending(); resultValue(await f.select());
      resultValue(await f.confirm("book")); f.provider.fail(cause); resultValue(await f.drain());
      const action = Object.values((await f.state()).actions).find(action => action.kind === "book")!;
      assert.equal(action.status, cause === "slot" ? "rejected" : "uncertain", cause);
      assert.equal(f.provider.patientPosts, 1); assert.ok(f.provider.patient); assert.equal(f.mail.length, 1);
      assert.equal(f.provider.bookingPosts, cause.startsWith("review") || cause === "slot" ? 0 : 1);
      assert.equal(f.provider.recalls.length, ["slot", "reviewRejected"].includes(cause) ? 0 : 1);
      f.provider.fail(""); resultValue(await f.drain());
      assert.equal(Object.values((await f.state()).actions).find(item => item.kind === "book")!.status, action.status);
      assert.equal(f.provider.traffic.some(item => /^(DELETE|PATCH)/.test(item)), false);
      const shown = (await f.state()).presentations[(await f.state()).pendingPresentationId!];
      if (shown?.kind === "notice") assert.doesNotMatch(shown.approvedText, /appointment is booked|successfully booked/i);
    } finally { await f.close(); }
  }
});

test("E2E-296 intake confirmation does not satisfy an unplayed or unaffirmed booking, and late permission/slot changes block send after saved review", async () => {
  for (const cause of ["unplayed", "unaffirmed", "permission", "slot"] as const) {
    const f = await intakeBookingSessionFixture();
    try {
      await f.register(); await f.playPending(); resultValue(await f.readMenu()); await f.playPending(); resultValue(await f.select());
      if (cause !== "unaffirmed") await f.confirm("book", cause !== "unplayed");
      if (cause === "permission") f.provider.onRecall(async () => { f.setPermitted(false); });
      if (cause === "slot") f.provider.onRecall(async () => { f.provider.fail("slot"); });
      resultValue(await f.drain()); assert.equal(f.provider.bookingPosts, 0); assert.equal(f.provider.patientPosts, 1);
      assert.equal(f.provider.recalls.length, ["permission", "slot"].includes(cause) ? 1 : 0);
    } finally { await f.close(); }
  }
});

test("E2E-296 combined owner rejects foreign binding, provider selection and unsupported factory timeout", async () => {
  const f = await intakeBookingSessionFixture();
  try {
    for (const patch of [{ sessionId: "foreign" }, { receipt: { ...f.receipt, callId: "foreign" } },
      { cliniko: { ...f.config.cliniko, businessId: "12" } }, { cliniko: { ...f.config.cliniko, practitionerId: "23" } }, { timeoutMs: 30_001 }]) {
      const result = await ClinikoIntakeBookingSession.create({ ...f.config, ...patch });
      if (result.ok) result.value.dispose(); assert.equal(result.ok, false);
    }
    assert.equal(f.provider.traffic.length, 0);
  } finally { await f.close(); }
});

test("E2E-296 captured booking disable stays denied after current enable; new enabled admission works and current disable revokes it", async () => {
  const disabled = await intakeBookingSessionFixture({ bookingExecute: false });
  try {
    await disabled.register(); await disabled.playPending();
    disabled.changeCurrent({ bookingEnabled: true, staffWorkEnabled: true,
      capabilities: { book: "execute", cancel: "unavailable", reschedule: "unavailable", intake: "execute", transfer: "unavailable" } });
    const denied = await disabled.readMenu(); assert.equal(denied.ok, false, "captured unavailable booking rejects the agent command");
    assert.equal((await disabled.owner.readBookingMenu({ scope: disabled.scope, callId: disabled.callId, sessionId: disabled.sessionId,
      policyVersion: "policy-1", turnId: "private-menu", now: disabled.now, signal: new AbortController().signal, from: "2026-10-08", to: "2026-10-08" })).ok, false);
    assert.equal(Object.values((await disabled.state()).actions).filter(action => action.kind === "book").length, 0);
    assert.equal(disabled.provider.bookingPosts, 0); assert.equal(disabled.provider.recalls.length, 0);
  } finally { await disabled.close(); }
  const enabled = await intakeBookingSessionFixture();
  try {
    await enabled.register(); await enabled.playPending(); resultValue(await enabled.readMenu()); await enabled.playPending();
    enabled.changeCurrent({ bookingEnabled: false }); await enabled.select(); resultValue(await enabled.drain());
    assert.equal(enabled.provider.bookingPosts, 0); assert.equal(enabled.provider.recalls.length, 0);
  } finally { await enabled.close(); }
});

test("E2E-296 permission abandoned during proof issuance cannot publish a menu or retained grant after owner disposal", async () => {
  const f = await intakeBookingSessionFixture(); let release: () => void = () => undefined, entered: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.register(); await f.playPending(); f.onBookingPermission(async () => { entered(); await held; });
    const reading = f.readMenu(); await waiting; f.owner.dispose(); release(); await reading;
    assert.equal(Object.values((await f.state()).actions).filter(action => action.kind === "book").length, 0);
    assert.equal(f.provider.bookingPosts, 0); assert.equal(f.provider.recalls.length, 0);
    assert.equal(await f.owner.intake.createdPatient(), undefined);
  } finally { release(); await f.close(); }
});

test("E2E-296 delayed booking issuance retains the original mailbox expiry despite renewed call leases", async () => {
  const f = await intakeBookingSessionFixture();
  try {
    await f.register(); await f.playPending(); const source = await f.owner.intake.createdPatient(); assert.ok(source);
    for (let seconds = 20; seconds <= 60; seconds += 20) {
      f.setTime(new Date(Date.parse("2026-10-04T12:00:00.000Z")+seconds*1000).toISOString());
      resultValue(await f.runtime.renewSession(f.callId, f.sessionId, (await f.state()).sessionLease!.version, f.now));
    }
    resultValue(await f.readMenu()); await f.playPending(); resultValue(await f.select());
    const request = Object.values((await f.state()).actions).find(action => action.kind === "book")!.mutation.request;
    assert.equal(request.kind, "book"); if (request.kind === "book") assert.equal(request.patient.expiresAt, source.expiresAt);
    assert.equal(f.mail.length, 1); assert.equal(f.provider.patientPosts, 1); assert.equal(f.provider.bookingPosts, 0);
  } finally { await f.close(); }
});
