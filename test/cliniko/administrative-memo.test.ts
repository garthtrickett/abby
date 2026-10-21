import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, administrativeMemoActionRef, encodeAdministrativeMemo, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoInput } from "../support/administrative-memo.ts";

for (const kind of ["bookingConfirmed", "reschedulingObserved", "cancellationObserved", "classBookingConfirmed", "classCancellationObserved", "classMovementReported"] as const)
test(`administrative ${kind} has exact canonical authenticated facts without free prose`, () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput(kind), signed = auth.sign(input);
  assert.ok(signed.ok); if (!signed.ok) return;
  const content = encodeAdministrativeMemo(signed.value); assert.ok(content.ok); if (!content.ok) return;
  const parsed = decodeAdministrativeMemo(content.value); assert.ok(parsed.ok); if (!parsed.ok) return;
  assert.deepEqual(parsed.value, signed.value); assert.equal(auth.verify(parsed.value), true); assert.ok(content.value.includes("(UTC)"));
  assert.equal(Object.isFrozen(parsed.value.outcome), true); assert.equal(Object.isFrozen(parsed.value.scope), true);
});

test("a class memo requires the exact patient attendee and occurrence without payment or whole-move claims", () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput("classBookingConfirmed");
  const signed = auth.sign(input); assert.ok(signed.ok); const content = encodeAdministrativeMemo(signed.value); assert.ok(content.ok);
  assert.match(content.value.split("\n")[1]!, /^Confirmed class booking for patient attendee cliniko:attendee:901, occurrence cliniko:booking:900:/);
  for (const change of [{ attendeeRef: undefined }, { attendeeRef: "cliniko:appointment:901" }, { appointmentRef: "cliniko:appointment:900" },
    { payment: "paid" }, { move: "completed" }, { patientCaseId: "811" }, { sharedClassNote: "all patients" }]) {
    assert.equal(auth.sign({ ...input, outcome: { ...input.outcome, ...change } } as typeof input).ok, false);
  }
});

test("a class cancellation memo retains inspected best-effort truth without a pass-release or refund claim", () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput("classCancellationObserved"), signed = auth.sign(input);
  assert.ok(signed.ok); const content = encodeAdministrativeMemo(signed.value); assert.ok(content.ok); assert.match(content.value.split("\n")[1]!, /^Observed cancelled patient attendee/);
  for (const change of [{ attendeeRef: undefined }, { attendeeRef: "cliniko:appointment:901" }, { verification: undefined },
    { verification: { basis: "exactAcknowledgement", observedAt: input.occurredAt } }, { refund: "paid" }, { passReleased: true }]) {
    assert.equal(auth.sign({ ...input, outcome: { ...input.outcome, ...change } } as typeof input).ok, false);
  }
});

test("the memo purpose depends only on its original action, not operation/template/patient/key", () => {
  const input = administrativeMemoInput(), action = administrativeMemoActionRef(input.sourceActionRef);
  assert.equal(action, input.actionRef); assert.notEqual(action, input.sourceActionRef);
  const auth = new AdministrativeMemoAuthentication(randomBytes(32));
  for (const patch of [{ authorRef: "another-author" }, { patientId: "322" }, { policy: { version: "v2", digest: "b".repeat(64) } },
    { outcome: administrativeMemoInput("cancellationObserved").outcome }]) {
    const signed = auth.sign({ ...input, ...patch }); assert.ok(signed.ok); if (signed.ok) assert.equal(signed.value.actionRef, action);
  }
  assert.equal(administrativeMemoActionRef("caller-picked-purpose"), undefined);
});

test("observed changes retain their best-effort basis and inspection time instead of claiming writer causality", () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32));
  for (const kind of ["cancellationObserved", "reschedulingObserved"] as const) {
    const input = administrativeMemoInput(kind), result = auth.sign(input); assert.ok(result.ok);
    const encoded = encodeAdministrativeMemo(result.value); assert.ok(encoded.ok); assert.ok(encoded.value.includes("Observed"));
    assert.equal(encoded.value.includes("Confirmed cancellation"), false); assert.equal(encoded.value.includes("Rescheduled cliniko:"), false);
    const changed = structuredClone(input);
    if (changed.outcome.kind === "cancellationObserved" || changed.outcome.kind === "reschedulingObserved") {
      (changed.outcome.verification as { observedAt: string }).observedAt = "2026-11-01T00:00:00.000Z";
      assert.equal(auth.sign(changed).ok, false);
    }
  }
});

test("a practitioner-only rescheduling observation requires a real change and the original unchanged duration", () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput("reschedulingObserved");
  assert.ok(input.outcome.kind === "reschedulingObserved");
  const outcome = { ...input.outcome, practitionerRef: "cliniko:practitioner:23", previous: { ...input.outcome.previous,
    startsAt: input.outcome.startsAt, endsAt: input.outcome.endsAt } };
  assert.ok(auth.sign({ ...input, outcome }).ok);
  assert.equal(auth.sign({ ...input, outcome: { ...outcome, practitionerRef: outcome.previous.practitionerRef } }).ok, false);
  assert.equal(auth.sign({ ...input, outcome: { ...outcome, endsAt: "2026-11-05T02:00:00.000Z" } }).ok, false);
});

for (const changed of ["freeText", "wrongPurpose", "sharedClass", "wrongInterval", "invalidDate", "wrongTimeOrder", "foreignKey", "extraAuthentication"] as const)
test(`administrative memo rejects ${changed} before it becomes canonical native content`, () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input: any = administrativeMemoInput();
  if (changed === "freeText") input.transcript = "private source is forbidden";
  if (changed === "wrongPurpose") input.actionRef = input.sourceActionRef;
  if (changed === "sharedClass") input.outcome.appointmentRef = "cliniko:group-appointment:900";
  if (changed === "wrongInterval") input.outcome.endsAt = input.outcome.startsAt;
  if (changed === "invalidDate") input.outcome.startsAt = "2026-02-30T01:00:00.000Z";
  if (changed === "wrongTimeOrder") input.occurredAt = "2026-11-03T00:00:00.000Z";
  if (changed === "extraAuthentication") input.authentication = "0".repeat(64);
  if (changed !== "foreignKey") { assert.equal(auth.sign(input).ok, false); return; }
  const signed = auth.sign(input); assert.ok(signed.ok); if (signed.ok) assert.equal(new AdministrativeMemoAuthentication(randomBytes(32)).verify(signed.value), false);
});

test("native content edits, noncanonical payloads and forged MACs do not preserve authenticity", () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), signed = auth.sign(administrativeMemoInput()); assert.ok(signed.ok); if (!signed.ok) return;
  const encoded = encodeAdministrativeMemo(signed.value); assert.ok(encoded.ok); if (!encoded.ok) return;
  assert.equal(decodeAdministrativeMemo(encoded.value.replace("Confirmed booking", "Staff confirmed booking")).ok, false);
  assert.equal(decodeAdministrativeMemo(encoded.value + "\nprivate tail").ok, false);
  assert.equal(decodeAdministrativeMemo(encoded.value.replace('"patientId":"321"', '"patientId":"321","patientId":"321"')).ok, false);
  assert.equal(auth.verify({ ...signed.value, patientId: "322" }), false);
  assert.equal(auth.verify({ ...signed.value, authentication: "f".repeat(64) }), false);
});

test("authentication copies the key and canonical fields before a caller can replace them", () => {
  const key = randomBytes(32), auth = new AdministrativeMemoAuthentication(key), before = new AdministrativeMemoAuthentication(key), input = administrativeMemoInput();
  const signed = auth.sign(input); assert.ok(signed.ok); if (!signed.ok) return;
  key.fill(0); (input.scope as any).clinicId = "changed"; (input.outcome as any).startsAt = "private text";
  assert.equal(before.verify(signed.value), true); assert.equal(auth.verify(signed.value), true);
  assert.throws(() => { (auth as any).verify = () => true; });
});

for (const bad of ["falseCompletion", "financial", "wrongGrade", "wrongSource", "missingReplacement", "noEffect", "foreignTimestamp"] as const)
test(`class movement memo refuses ${bad} without upgrading a partial native report`, () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput("classMovementReported");
  assert.ok(input.outcome.kind === "classMovementReported"); const outcome = structuredClone(input.outcome);
  if (bad === "falseCompletion") (outcome as { completion: string }).completion = "moved";
  if (bad === "financial") Object.assign(outcome, { refunded: true });
  if (bad === "wrongGrade") Object.assign(outcome.verification, { basis: "acknowledgedAndObservedBestEffort" });
  if (bad === "wrongSource") Object.assign(outcome.original, { appointmentRef: outcome.appointmentRef });
  if (bad === "missingReplacement") delete (outcome as { replacementAttendeeRef?: string }).replacementAttendeeRef;
  if (bad === "noEffect") Object.assign(outcome.progress, { replacement: "notSent" });
  if (bad === "foreignTimestamp") Object.assign(outcome.verification, { reportedAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(auth.sign({ ...input, outcome }).ok, false);
});
