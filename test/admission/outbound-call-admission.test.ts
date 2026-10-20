import assert from "node:assert/strict";
import test from "node:test";
import type { Admission } from "../../src/core/model.ts";
import { validPendingAdmission } from "../../src/core/pending-location.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { ok } from "../../src/core/model.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { approvedSyntheticPolicy } from "../support/approved-voice.ts";
const now = "2026-11-01T10:00:00.000Z";
const scope = { tenantId: "outbound-admission", clinicId: "clinic", locationId: "main" };
const policy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true });
const outbound = () => ({ direction: "outbound" as const, key: { accountRef: "synthetic-account", providerCallRef: "synthetic-outbound-call" },
  clinicNumber: "+61255550100", acceptedAt: now, deadline: "2026-11-01T10:00:30.000Z" });

test("outbound admission has its own public clinic-number role and uses the existing call/session lifecycle", async () => {
  const ledger = new MemoryLedger(), start = outbound(), result = await ledger.admit("outbound-call", policy, start);
  assert.equal(result.ok, true, "outbound admission must not require a fabricated incoming dialled number");
  if (!result.ok) return;
  assert.deepEqual(result.value.receipt.admission, start); assert.equal("dialedNumber" in result.value.receipt.admission, false);
  const runtime = new CallRuntime(ledger, scope), active = await runtime.activate("outbound-call", "session", now);
  assert.equal(active.ok, true); if (!active.ok) return;
  assert.equal(active.value.lifecycle, "active"); assert.deepEqual(active.value.admission, start);
});
test("outbound intent mixed with a private dialled destination is rejected before a call can be stored", async () => {
  const ledger = new MemoryLedger(), unsafe = { ...outbound(), dialedNumber: "+61455550999" };
  assert.equal((await ledger.admit("unsafe-outbound", policy, unsafe as unknown as Admission)).ok, false,
    "a recipient must not masquerade as the legacy incoming public clinic number");
  const found = await ledger.findAdmission("unsafe-outbound"); assert.equal(found.ok, true); if (found.ok) assert.equal(found.value, null);
});
test("a recipient or original native context cannot be appended to the outbound durable admission", async () => {
  for (const extra of [{ recipientNumber: "+61455550999" }, { context: { patientId: "482746192837465", recallRef: "cliniko:recall:40" } }]) {
    const ledger = new MemoryLedger(), unsafe = { ...outbound(), ...extra };
    assert.equal((await ledger.admit("unsafe-context", policy, unsafe as unknown as Admission)).ok, false);
    const found = await ledger.findAdmission("unsafe-context"); assert.equal(found.ok, true); if (found.ok) assert.equal(found.value, null);
  }
});
test("existing valid inbound admissions retain their original stored shape", async () => {
  const ledger = new MemoryLedger(), start = { key: { accountRef: "synthetic-account", providerCallRef: "inbound-call" },
    dialedNumber: "+61255550100", acceptedAt: now, deadline: "2026-11-01T10:00:30.000Z" };
  const result = await ledger.admit("inbound-call", policy, start); assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.receipt.admission, start);
});

test("outbound replay preserves direction and public clinic identity; incoming ingress cannot adopt it", async () => {
  const ledger = new MemoryLedger(), start = outbound(), callId = callIdFor(start.key);
  assert.equal((await ledger.admit(callId, policy, start)).ok, true);
  const duplicate = await ledger.admit(callId, policy, { ...start, acceptedAt: "2026-11-01T10:00:01.000Z" });
  assert.equal(duplicate.ok, true); if (duplicate.ok) assert.equal(duplicate.value.kind, "duplicate");
  assert.deepEqual(await ledger.admit(callId, policy, { ...start, clinicNumber: "+61255550101" }),
    { ok: false, error: { kind: "callConflict" } });
  const service = new CallAdmissionService(ledger, async () => ok(policy), () => now, async () => ok(true));
  assert.deepEqual(await service.begin({ key: start.key, dialedNumber: start.clinicNumber, receivedAt: now }),
    { ok: false, error: { kind: "callConflict" } });
  assert.equal(validPendingAdmission(callId, start), false);
  assert.equal(validPendingAdmission(callId, { ...start, dialedNumber: start.clinicNumber }), false);
});
test("admission rejects unsupported directions, malformed timing and private provider-key additions", async () => {
  for (const extra of [{ direction: "unknown" }, { acceptedAt: "not-a-date" }, { deadline: "not-a-date" },
    { deadline: now }, { clinicNumber: "" }, { key: { ...outbound().key, patientId: "482746192837465" } }]) {
    const ledger = new MemoryLedger();
    assert.deepEqual(await ledger.admit("invalid-shape", policy, { ...outbound(), ...extra } as unknown as Admission),
      { ok: false, error: { kind: "invalidTransition" } });
    const found = await ledger.findAdmission("invalid-shape"); if (found.ok) assert.equal(found.value, null);
  }
});
