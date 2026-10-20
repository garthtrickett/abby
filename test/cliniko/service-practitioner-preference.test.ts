import assert from "node:assert/strict";
import test from "node:test";
import { validBookingPractitionerPreference } from "../../src/core/booking-practitioner-preference.ts";
import { copyBookingServiceChoice, validBookingServiceChoice } from "../../src/core/booking-service-choice.ts";
import { eligibleServicePractitioners, servicePractitionerPreferenceLanguage } from "../../src/standalone/service-practitioner-preference.ts";
import { serviceBookingConfig } from "../../src/standalone/service-booking-config.ts";
import { OwnerFileBookingCatalogue } from "../../src/standalone/owner-file-booking-catalogue.ts";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { servicePractitionerFixture } from "../support/service-practitioner-preference.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-349 preferences accept only explicit public constraints and never infer unknown gender or provider IDs", () => {
  assert.deepEqual(servicePractitionerPreferenceLanguage("I prefer a female physiotherapist."), { kind: "gender", gender: "female" });
  assert.deepEqual(servicePractitionerPreferenceLanguage("Demo B, please.", true), { kind: "name", name: "Demo B" });
  assert.equal(servicePractitionerPreferenceLanguage("female"), undefined);
  assert.equal(servicePractitionerPreferenceLanguage('My friend said "I prefer a female physiotherapist".'), undefined);
  for (const value of [{ kind: "gender", gender: "unknown" }, { kind: "gender", gender: "female", practitionerId: "23" },
    { kind: "any", approvalPath: "/private" }, { kind: "name", name: "any" }]) assert.equal(validBookingPractitionerPreference(value), false);
  const members = [{ practitionerId: "22", name: "Alice" }, { practitionerId: "23", name: "Bob", gender: "female" as const }];
  assert.deepEqual(eligibleServicePractitioners(members, { kind: "gender", gender: "female" }).map(member => member.practitionerId), ["23"]);
  const incoming = { name: "Physiotherapy", visitKind: "initial" as const, durationMinutes: 60,
    practitionerPreference: { kind: "gender" as const, gender: "female" as "female" | "male" } };
  const copied = copyBookingServiceChoice(incoming)!; incoming.practitionerPreference.gender = "male";
  assert.deepEqual(copied.practitionerPreference, { kind: "gender", gender: "female" });
  assert.equal(validBookingServiceChoice({ ...incoming, practitionerPreference: { kind: "gender", gender: "female", providerId: "23" } }), false);
});

test("E2E-349 current selected catalogue and each independent writer retain only the approved preference subset", async () => {
  const f = await servicePractitionerFixture();
  try {
    const config = resultValue(await serviceBookingConfig(f.flowConfig, { name: "Physiotherapy", visitKind: "initial", durationMinutes: 60,
      practitionerPreference: { kind: "gender", gender: "female" } }));
    assert.equal(config.cliniko.practitionerId, "23");
    assert.deepEqual(config.catalogue.practitioners.map(member => member.practitionerId), ["23", "24"]);
    const common = { scope: f.scope, policyVersion: config.policyVersion, businessId: "11", appointmentTypeId: "34",
      credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: "Australia/Sydney", directory: f.directory, clock: () => verificationNow,
      serviceBinding: config.catalogue.serviceBinding };
    const catalogue = resultValue(await OwnerFileBookingCatalogue.capture({ ...common, path: config.catalogue.approvalPath }));
    assert.deepEqual(resultValue(await catalogue.current(f.scope)).practitioners, [{ practitionerId: "23", name: "Demo B" }, { practitionerId: "24", name: "Demo C" }]);
    const denied = await OwnerFileBookingPolicy.capture({ ...common, path: f.initialPath, practitionerId: "22", recallTypeId: "7" });
    assert.equal(denied.ok, false, "a male writer cannot borrow the female subset binding");
    assert.equal(f.mail.length, 0);
    await f.replaceServices({ enabled: false }); assert.equal((await catalogue.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("E2E-349 ordinary time preferences cannot silently become a new service/practitioner choice", async () => {
  const f = await servicePractitionerFixture();
  try {
    assert.equal((await f.flow.choose("book", undefined, false, undefined, { name: "Physiotherapy", visitKind: "initial", durationMinutes: 60,
      practitionerPreference: { kind: "gender", gender: "female" } })).ok, true);
    f.flow.beginVerification();
    const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, 1); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    assert.equal(await f.flow.servicePractitionerIntent(f.turn("time-preference", "I prefer Mondays.")), undefined);
    assert.equal(f.flow.workflow, "book"); assert.equal(f.mail.length, 1); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-349 contradictory approved gender labels for the same practitioner cannot issue verification", async () => {
  const f = await servicePractitionerFixture();
  try {
    await f.replaceServices({ services: f.serviceApproval.services.map(service => service.appointmentTypeId === "33" ? { ...service,
      practitioners: service.practitioners.map(member => ({ ...member, gender: "female" as const })) } : service) });
    assert.equal((await f.flow.choose("book", undefined, false, undefined, { name: "Physiotherapy", visitKind: "initial", durationMinutes: 60,
      practitionerPreference: { kind: "gender", gender: "female" } })).ok, false);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
