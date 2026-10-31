// E2E-387/E2E-388: a played enquiry precedes a separately verified caller/related booking.
import assert from "node:assert/strict";
import test from "node:test";
import { completedAppointmentEnquiry } from "../../src/core/completed-appointment-enquiry.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { relatedSelfTaskSequenceFixture as fixture } from "../support/related-self-task-sequence.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function assertPrivate(f: Fixture) {
  const publicData = JSON.stringify([await f.base.f.state(), await f.flow.publicIntentContext()]);
  for (const value of [f.base.r.identity.firstName, f.base.r.identity.lastName, f.base.r.identity.dateOfBirth,
    ...f.base.mail.flatMap(row => [row.code, row.email])]) assert.equal(publicData.includes(value), false);
}

test("a played related-patient enquiry can precede native caller booking with fresh proof and an immutable read", async () => {
  const f = await fixture({ enquiry: true });
  try {
    const owner = await f.startRelatedEnquiry(), first = await f.readEnquiry(); assert.equal(first.status, "shown");
    assert.equal(completedAppointmentEnquiry(await f.base.f.state()), undefined);
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true,
      expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(owner.closed, false); assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 0);
    await f.play(); assert.deepEqual(completedAppointmentEnquiry(await f.base.f.state()), first); await f.nextWindow();
    resultValue(await f.startSelf()); await f.play(); await f.base.waitForMail(3);
    assert.equal(owner.closed, true); assert.equal(f.flow.representativeInputOwner, undefined);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, false);
    assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, false);
    assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, true);
    assert.equal(completedAppointmentEnquiry(await f.base.f.state()), undefined);
    assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
    const booking = await f.book(); assert.equal(booking.status, "committed");
    assert.deepEqual(f.native.requests.map(row => row.patient_id), [verificationCanaries[2]]);
    assert.deepEqual((await f.base.f.state()).appointmentReads[0], first);
    assert.equal(Object.keys((await f.base.f.state()).actions).length, 1); await assertPrivate(f);
  } finally { await f.close(); }
});

test("a played native caller enquiry can precede related-patient booking with new actor and subject proofs", async () => {
  const f = await fixture({ enquiry: true });
  try {
    await f.verifyCallerEnquiry(); const first = await f.readEnquiry(); assert.equal(first.status, "shown");
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forAnotherPerson: true,
      expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(f.base.mail.length, 1); await f.play(); await f.nextWindow();
    const owner = await f.prepareRelated();
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, false);
    assert.equal(owner.beginCallerVerification(), true); await f.base.waitForMail(2);
    assert.equal((await owner.submitCallerCode(f.base.mail[1]!.code)).verified, true);
    resultValue(await owner.selectPatient(f.base.r.identity)); assert.equal(owner.beginPatientVerification(), true); await f.base.waitForMail(3);
    assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, true);
    assert.equal(completedAppointmentEnquiry(await f.base.f.state()), undefined);
    assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
    const booking = await f.book(); assert.equal(booking.status, "committed");
    assert.deepEqual(f.native.requests.map(row => row.patient_id), [f.base.r.subjectIds[0]]);
    assert.deepEqual((await f.base.f.state()).appointmentReads[0], first);
    assert.equal(Object.keys((await f.base.f.state()).actions).length, 1); await assertPrivate(f);
  } finally { await f.close(); }
});

test("a failed related-patient enquiry cannot establish a caller-booking task", async () => {
  const f = await fixture({ enquiry: true });
  try {
    const owner = await f.startRelatedEnquiry(); f.base.setReadFailure(); const first = await f.readEnquiry();
    assert.equal(first.status, "failed"); await f.play(); assert.equal(completedAppointmentEnquiry(await f.base.f.state()), undefined);
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true,
      expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(owner.closed, false); assert.equal(f.flow.representativeInputOwner, owner);
    assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
    assert.deepEqual((await f.base.f.state()).appointmentReads[0], first); await assertPrivate(f);
  } finally { await f.close(); }
});

test("withdrawn task approval preserves the related enquiry and refuses caller-booking preparation", async () => {
  const f = await fixture({ enquiry: true });
  try {
    const owner = await f.startRelatedEnquiry(), first = await f.readEnquiry(); await f.play();
    await f.source.replace({ enabled: false });
    assert.equal((await f.flow.startWorkflow({ ...f.query(), forCaller: true,
      expectedConversationRevision: (await f.base.f.state()).conversationRevision })).ok, false);
    assert.equal(owner.closed, false); assert.equal(f.flow.representativeInputOwner, owner);
    assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
    assert.deepEqual((await f.base.f.state()).appointmentReads[0], first); await assertPrivate(f);
  } finally { await f.close(); }
});

test("caller permission remains independent after a completed related-patient enquiry", async () => {
  const f = await fixture({ enquiry: true });
  try {
    const owner = await f.startRelatedEnquiry(), first = await f.readEnquiry(); await f.play(); await f.nextWindow();
    resultValue(await f.startSelf()); await f.play(); await f.base.waitForMail(3); f.denySelf();
    assert.equal((await f.flow.submitCode(f.base.mail[2]!.code)).verified, false);
    assert.equal(owner.closed, true); assert.equal(f.flow.verificationRequired, true);
    assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
    assert.deepEqual((await f.base.f.state()).appointmentReads[0], first); await assertPrivate(f);
  } finally { await f.close(); }
});

for (const fault of ["actor", "subject"] as const)
  test(`a native caller enquiry cannot transfer ${fault} authority into a related booking`, async () => {
    const f = await fixture({ enquiry: true });
    try {
      await f.verifyCallerEnquiry(); const first = await f.readEnquiry(); await f.play(); await f.nextWindow();
      const owner = await f.prepareRelated(); assert.equal(owner.beginCallerVerification(), true); await f.base.waitForMail(2);
      assert.equal((await owner.submitCallerCode(f.base.mail[1]!.code)).verified, true);
      if (fault === "actor") f.base.revokeActor(); else f.base.revokeSubject();
      const selected = await owner.selectPatient(f.base.r.identity);
      if (fault === "actor") assert.equal(selected.ok, false);
      else {
        assert.equal(selected.ok, true); f.flow.beginVerification();
        assert.equal((await f.flow.submitCode("000000")).verified, false);
      }
      assert.equal(f.base.mail.length, 2); assert.equal(f.native.requests.length, 0); assert.equal(f.base.f.recalls.length, 0);
      assert.deepEqual((await f.base.f.state()).appointmentReads[0], first); await assertPrivate(f);
    } finally { await f.close(); }
  });
