import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, administrativeMemoActionRef, encodeAdministrativeMemo, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoInput } from "../support/administrative-memo.ts";

for (const kind of ["bookingConfirmed", "reschedulingConfirmed", "cancellationConfirmed"] as const)
test(`administrative ${kind} has exact canonical authenticated facts without free prose`, () => {
  const auth = new AdministrativeMemoAuthentication(randomBytes(32)), input = administrativeMemoInput(kind), signed = auth.sign(input);
  assert.ok(signed.ok); if (!signed.ok) return;
  const content = encodeAdministrativeMemo(signed.value); assert.ok(content.ok); if (!content.ok) return;
  const parsed = decodeAdministrativeMemo(content.value); assert.ok(parsed.ok); if (!parsed.ok) return;
  assert.deepEqual(parsed.value, signed.value); assert.equal(auth.verify(parsed.value), true); assert.ok(content.value.includes("(UTC)"));
  assert.equal(Object.isFrozen(parsed.value.outcome), true); assert.equal(Object.isFrozen(parsed.value.scope), true);
});

test("the memo purpose depends only on its original action, not operation/template/patient/key", () => {
  const input = administrativeMemoInput(), action = administrativeMemoActionRef(input.sourceActionRef);
  assert.equal(action, input.actionRef); assert.notEqual(action, input.sourceActionRef);
  const auth = new AdministrativeMemoAuthentication(randomBytes(32));
  for (const patch of [{ authorRef: "another-author" }, { patientId: "322" }, { policy: { version: "v2", digest: "b".repeat(64) } },
    { outcome: { ...input.outcome, kind: "cancellationConfirmed" as const } }]) {
    const signed = auth.sign({ ...input, ...patch }); assert.ok(signed.ok); if (signed.ok) assert.equal(signed.value.actionRef, action);
  }
  assert.equal(administrativeMemoActionRef("caller-picked-purpose"), undefined);
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
