import assert from "node:assert/strict";
import test from "node:test";
import { intakeAllowedFields, intakeRequiredFields, OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import { intakePolicyFixture } from "../support/intake-policy.ts";
import { intakeSessionFixture } from "../support/intake-session.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { privateRegistrationField } from "../../src/standalone/private-registration-field.ts";

const address = { address1: "1 Private Road", address2: "Private Flat", address3: "Private Building", city: "Private City",
  // A full postal value with nonhex characters cannot match an unrelated UUID
  // or digest. Keep the unfiltered whole-SAM substring privacy assertions below.
  state: "BC", postCode: "V6B 1A1", countryCode: "CA" };
test("E2E-369 clinic-required registration fields must be complete, approved and current", async () => {
  const f = await intakePolicyFixture();
  try {
    assert.equal((await f.policy.checkDraft({ ...f.query, draft: { ...intakeDraft, ...address } })).ok, false);
    await f.replaceApproval({ requiredFields: [...intakeAllowedFields] });
    const policy = resultValue(await OwnerFileIntakePolicy.capture(f.config));
    assert.equal((await policy.checkDraft({ ...f.query, draft: { ...intakeDraft, ...address } })).ok, true);
    for (const field of Object.keys(address)) {
      const draft = { ...intakeDraft, ...address }; Reflect.deleteProperty(draft, field);
      assert.equal((await policy.checkDraft({ ...f.query, draft })).ok, false);
    }
    await f.replaceApproval({ requiredFields: [...intakeRequiredFields, "address1"] });
    assert.equal((await policy.checkDraft({ ...f.query, draft: { ...intakeDraft, ...address } })).ok, false);
    assert.equal(privateRegistrationField("postCode", "remove this value", "61"), undefined);
    assert.equal(privateRegistrationField("address1", "Please wait.", "61"), undefined);
    assert.deepEqual(privateRegistrationField("countryCode", "A U", "61"), { kind: "value", value: "AU" });
  } finally { await f.close(); }
});

test("E2E-369 private registration reads back all required fields before proof and creates only after separate confirmation", async () => {
  const f = await intakeSessionFixture({ requiredFields: [...intakeAllowedFields] });
  try {
    const terms = resultValue(await f.owner.begin()); assert.deepEqual(terms.requiredFields, intakeAllowedFields);
    assert.equal(await f.owner.acknowledgeRecovery(terms.recoveryRef, true), true);
    assert.equal((await f.owner.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true })).ok, false);
    assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
    const draft = resultValue(await f.owner.collect({ ...intakeDraft, ...address }, { privacyAccepted: true, intakeAccepted: true }));
    for (const value of Object.values(address)) assert.ok(f.presented.some(text => text.includes(value)));
    assert.equal((await f.owner.submitCode(f.mail.at(-1)!.code)).verified, true);
    assert.equal((await f.propose(draft.draftRef)).ok, true); assert.equal(f.posts, 0);
    resultValue(await f.confirm()); await f.drain(); assert.equal(f.posts, 1);
    assert.equal(f.row!.address_1, address.address1); assert.equal(f.row!.post_code, address.postCode);
    assert.equal(JSON.stringify(await f.state()).includes(address.address1), false);
    assert.equal(JSON.stringify(await f.state()).includes(address.postCode), false);
  } finally { await f.close(); }
});

test("E2E-369 long required-field readback is split without skipping any field or playback", async () => {
  const f = await intakeSessionFixture({ requiredFields: [...intakeAllowedFields] });
  try {
    const terms = resultValue(await f.owner.begin()); assert.equal(await f.owner.acknowledgeRecovery(terms.recoveryRef, true), true);
    const long = { ...intakeDraft, firstName: "a".repeat(50), lastName: "b".repeat(255), email: `${"e".repeat(210)}@example.test`, ...Object.fromEntries(Object.keys(address).filter(key => key !== "countryCode")
      .map((key, i) => [key, `${i}-${"x".repeat(250)}`])), countryCode: "AU" };
    resultValue(await f.owner.collect(long, { privacyAccepted: true, intakeAccepted: true }));
    const parts = f.presented.filter(text => text.startsWith("Registration details:"));
    assert.ok(parts.length > 1); assert.ok(parts.every(text => text.length <= 2000));
    for (const field of Object.keys(address)) assert.ok(parts.some(text => text.includes(long[field as keyof typeof long] as string)));
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
