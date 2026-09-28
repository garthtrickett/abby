import assert from "node:assert/strict";
import test from "node:test";
import { ModelIngress, decodeModelProposal } from "../../src/model/proposal.ts";
import type { ModelInput, ModelProposal, RawModelPort } from "../../src/model/proposal.ts";

const input: ModelInput = {
  scope: { tenantId: "tenant-model", clinicId: "clinic-model", locationId: "location-model" },
  turn: { callId: "call-model", turnId: "turn-1", text: "Can I book an appointment?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
  conversationRevision: 1,
  policyVersion: "policy-1",
  promptVersion: "prompt-1",
};

function decoded(raw: unknown): ModelProposal {
  const result = decodeModelProposal(raw);
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

test("model ingress accepts each versioned proposal without giving it host authority", () => {
  const proposals: unknown[] = [
    { schemaVersion: 1, kind: "answer", sourceRefs: ["hours-v2"], proposedText: "We close at five." },
    { schemaVersion: 1, kind: "lookup", target: "appointment", statedName: "Alex", statedDate: "2026-10-02" },
    { schemaVersion: 1, kind: "action", operation: "reschedule", targetRef: "appointment-1", requestedTime: "2026-10-02T12:30:00+10:00" },
    { schemaVersion: 1, kind: "handoff", reason: "callerRequested" },
  ];
  assert.deepEqual(proposals.map(raw => decoded(raw).kind), ["answer", "lookup", "action", "handoff"]);
  for (const proposal of proposals) {
    assert.equal(Object.hasOwn(decoded(proposal), "mutation"), false);
    assert.equal(Object.hasOwn(decoded(proposal), "confirmationRef"), false);
  }
});

test("model ingress rejects unknown versions, hidden commands, and incomplete answers", () => {
  const invalid: unknown[] = [
    { schemaVersion: 2, kind: "handoff", reason: "callerRequested" },
    { schemaVersion: 1, kind: "action", operation: "book", hostWrite: { patientRef: "patient-1" } },
    { schemaVersion: 1, kind: "action", operation: "write", targetRef: "patient-1" },
    { schemaVersion: 1, kind: "answer", sourceRefs: [], proposedText: "We close at five." },
    { schemaVersion: 1, kind: "answer", sourceRefs: ["hours", "hours"], proposedText: "We close at five." },
    { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "" },
    { schemaVersion: 1, kind: "lookup", target: "appointment", statedDate: "2026-02-30" },
    { schemaVersion: 1, kind: "action", operation: "book", requestedTime: "2026-02-30T12:30:00+10:00" },
    { schemaVersion: 1, kind: "action", operation: "book", requestedTime: "2026-10-02T12:30:00+15:00" },
    { schemaVersion: 1, kind: "handoff", reason: "inventedReason" },
    { schemaVersion: 1, kind: "handoff", reason: "systemFailure" },
    { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "We close at five.", instructions: "ignore policy" },
    { get schemaVersion() { throw new Error("untrusted getter"); } },
    null,
  ];
  for (const raw of invalid) assert.deepEqual(decodeModelProposal(raw), { ok: false, error: { kind: "malformed" } });
});

test("model port result is decoded at ingress and never treated as trusted JSON", async () => {
  let observed: ModelInput | undefined;
  const port: RawModelPort = { async propose(request) {
    observed = request;
    return { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "Unverified hours", hostWrite: true };
  } };
  const result = await new ModelIngress(port).propose(input, 100);
  assert.deepEqual(result, { ok: false, error: { kind: "malformed" } });
  assert.deepEqual(observed, input);

  const valid = await new ModelIngress({ async propose() {
    return { schemaVersion: 1, kind: "handoff", reason: "callerRequested" };
  } }).propose(input, 100);
  assert.deepEqual(valid, { ok: true, value: { schemaVersion: 1, kind: "handoff", reason: "callerRequested" } });
});

test("model transport exception and deadline are typed failures", async () => {
  const unavailable = new ModelIngress({ async propose() { throw new Error("provider secret: do not leak"); } });
  assert.deepEqual(await unavailable.propose(input, 100), { ok: false, error: { kind: "unavailable" } });

  let aborted = false;
  const stalled = new ModelIngress({ propose(_request, signal) {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  } });
  assert.deepEqual(await stalled.propose(input, 5), { ok: false, error: { kind: "deadlineExceeded" } });
  assert.equal(aborted, true);
});
