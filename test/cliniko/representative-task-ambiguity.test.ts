// E2E-387/R04: a shared phone and name never select the next task subject.
import assert from "node:assert/strict";
import test from "node:test";
import { representativeTaskSequenceFixture } from "../support/representative-task-sequence.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";

for (const missing of ["omitted", "ambiguous"] as const) test(`E2E-387 R04 same-name shared-phone next subject is ${missing} without inheriting proof or receipt`, async () => {
  const budget = new ClinikoReadBudget(180, () => Date.parse(verificationNow));
  const caller = await representativeCallOwnerFixture({ multiplePatients: true, budget });
  const f = await representativeTaskSequenceFixture("independentlyVerifiedPatients", { caller, clock: () => verificationNow });
  try {
    const firstPatient = f.r.patients.get("43")!, secondPatient = f.r.patients.get("44")!;
    secondPatient.first_name = firstPatient.first_name; secondPatient.last_name = firstPatient.last_name;
    secondPatient.patient_phone_numbers = structuredClone(firstPatient.patient_phone_numbers);
    assert.equal(secondPatient.first_name, firstPatient.first_name); assert.equal(secondPatient.last_name, firstPatient.last_name);
    assert.deepEqual(secondPatient.patient_phone_numbers, firstPatient.patient_phone_numbers);
    const oldOwner = await f.verify("43"), first = await f.book(); assert.equal(first.status, "committed");
    const receipt = structuredClone(first);
    if (missing === "ambiguous") {
      secondPatient.date_of_birth = firstPatient.date_of_birth;
      f.r.authorizations.set("44", { ...f.r.authorizations.get("43")!, authorityRef: "separately-approved-other-adult" });
    }
    const owner = await f.start(); assert.notEqual(owner, oldOwner); assert.equal(oldOwner.closed, true);
    assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(3);
    assert.equal((await owner.submitCallerCode(f.mail[2]!.code)).verified, true);
    if (missing === "ambiguous") assert.equal((await owner.selectPatient({firstName: firstPatient.first_name,
      lastName: firstPatient.last_name, dateOfBirth: firstPatient.date_of_birth})).ok, false);
    assert.equal(owner.beginPatientVerification(), false);
    assert.equal((await f.reception.readBookingMenu(f.f.scope, f.f.turn("omitted-next-target", "Find a time"),
      "2026-10-08", "2026-10-08", verificationNow)).ok, false);
    if (first.mutation.request.kind !== "book") throw Error("wrong first operation");
    assert.equal((await f.flow.resolveBooking(f.f.scope, first.mutation.request.patient.verificationRef,
      first.mutation.request.offer.offerRef, verificationNow)).ok, false);
    assert.equal(f.mail.length, 3); assert.equal(f.native.requests.length, 1); assert.equal(f.f.recalls.length, 1);
    assert.deepEqual((await f.f.state()).actions[first.key], receipt);
    assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
    const projected = JSON.stringify([(await f.f.state()).callerMessages, await f.flow.publicIntentContext()]);
    for (const secret of [firstPatient.first_name, firstPatient.last_name, firstPatient.date_of_birth,
      ...f.mail.flatMap(row => [row.email,row.code])]) assert.equal(projected.includes(secret), false);
  } finally { await f.closeSequence(); }
});
