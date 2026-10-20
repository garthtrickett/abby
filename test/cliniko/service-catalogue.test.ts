import assert from "node:assert/strict";
import test from "node:test";
import { OwnerFileServiceCatalogue } from "../../src/standalone/owner-file-service-catalogue.ts";
import { validBookingServiceChoice } from "../../src/core/booking-service-choice.ts";
import { bookingServiceLanguage } from "../../src/standalone/booking-service-language.ts";
import { serviceBookingFixture } from "../support/service-booking-catalogue.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";

test("E2E-346 service catalogue resolves exact public type/duration and enforces approved return-visit answers", async () => {
  const f = await serviceBookingFixture();
  try {
    const catalogue = resultValue(await OwnerFileServiceCatalogue.capture({ path: f.servicePath, ...f.serviceApproval, directory: f.directory, clock: () => verificationNow }));
    const choice = { name: "Physiotherapy", visitKind: "initial" as const, durationMinutes: 60 };
    assert.equal(resultValue(await catalogue.select(f.scope, choice)).appointmentTypeId, "34");
    assert.equal((await catalogue.select(f.scope, { ...choice, name: "Unknown" })).ok, false);
    assert.equal(resultValue(await catalogue.select(f.scope, { ...choice, durationMinutes: 45 })).appointmentTypeId, "36");
    assert.equal((await catalogue.select(f.scope, { ...choice, durationMinutes: 90 })).ok, false);
    const follow = { ...choice, visitKind: "followUp" as const, durationMinutes: 30, returningPatient: true, newProblem: false, monthsSinceLastVisit: 2 };
    assert.equal(resultValue(await catalogue.select(f.scope, follow)).appointmentTypeId, "33");
    for (const changed of [{ returningPatient: false }, { newProblem: true }, { monthsSinceLastVisit: 4 }, { returningPatient: undefined }, { newProblem: undefined }, { monthsSinceLastVisit: undefined }]) {
      assert.equal((await catalogue.select(f.scope, { ...follow, ...changed } as typeof follow)).ok, false);
    }
    assert.equal((await catalogue.select({ ...f.scope, locationId: "other" }, choice)).ok, false);
    await f.replaceServices({ enabled: false }); assert.equal((await catalogue.select(f.scope, choice)).ok, false);
  } finally { await f.close(); }
});

test("E2E-346 public service requests cannot carry private bindings or infer history from general wording", () => {
  assert.deepEqual(bookingServiceLanguage("Book a sixty-minute initial Physiotherapy appointment."), { name: "Physiotherapy", durationMinutes: 60, visitKind: "initial" });
  assert.deepEqual(bookingServiceLanguage("Book a 30-minute follow-up Physiotherapy appointment. I am a returning patient, this is not a new problem, and my last visit was 2 months ago."),
    { name: "Physiotherapy", durationMinutes: 30, visitKind: "followUp", returningPatient: true, newProblem: false, monthsSinceLastVisit: 2 });
  for (const text of ['My friend said "Book a 60-minute initial Physiotherapy appointment".', "I do not want a 60-minute initial Physiotherapy appointment.",
    "What type is best for my injury?", "I have been here before.", "Book a 900-minute initial Physiotherapy appointment."]) assert.equal(bookingServiceLanguage(text), undefined);
  for (const patch of [{ appointmentTypeId: "34" }, { bookingApprovalPath: "/private/approval" }, { visitKind: "anything" }, { durationMinutes: 0 }]) {
    assert.equal(validBookingServiceChoice({ name: "Physiotherapy", visitKind: "initial", durationMinutes: 60, ...patch }), false);
  }
});

test("E2E-346 multi-service mode requires an explicit choice and no bad rule can issue patient verification", async () => {
  const f = await serviceBookingFixture();
  try {
    assert.equal((await f.flow.choose("book")).ok, false);
    assert.equal((await f.flow.choose("book", undefined, false, undefined, { name: "Physiotherapy", visitKind: "followUp", durationMinutes: 30 })).ok, false);
    assert.equal(f.mail.length, 0);
    await f.replaceServices({ services: [f.serviceApproval.services[0]!, { ...f.serviceApproval.services[1]!, appointmentTypeId: "33" }] });
    assert.equal((await f.flow.choose("book", undefined, false, undefined, { name: "Physiotherapy", visitKind: "initial", durationMinutes: 60 })).ok, false);
    assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

test("E2E-346 an unconfigured service variant cannot fall through to a guessed default booking", async () => {
  const f = await bookingCallFlowFixture();
  try {
    assert.deepEqual(f.flow.serviceChoiceIntent("Book a sixty-minute initial Physiotherapy appointment."), { kind: "clarify", reason: "changeUnsupported" });
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
