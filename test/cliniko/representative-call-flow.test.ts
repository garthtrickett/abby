import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { representativeWorkflowFixture } from "../support/representative-workflow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { verificationPhaseDiagnostics } from "../support/verification-phase-diagnostics.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

async function fixture(tasks = false) {
  const f = await representativeWorkflowFixture();
  const taskPath = join(f.f.folder, "self-task-sequence.json");
  if (tasks) {
    const process = JSON.parse(await readFile(f.r.policyConfig.path, "utf8"));
    const common = Object.fromEntries(["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled"].map(key => [key, process[key]]));
    await writeFile(taskPath, JSON.stringify({ ...common, policyVersion: f.config.policyVersion, businessId: f.config.cliniko.businessId,
      credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey), timeZone: f.config.cliniko.timeZone,
      maximumTasks: 2, operations: ["book"], patientSelection: "sameVerifiedCaller", verification: "freshEachTask", unresolvedActions: "denyNextTask" }), { mode: 0o600 });
  }
  const { representative: _representative, ...base } = f.config;
  const config = { ...base, ...(tasks ? { taskSequence: { approvalPath: taskPath } } : {}), approvals: {
    bookCaller: f.config.callerApprovalPath, cancelCaller: f.config.callerApprovalPath, rescheduleCaller: f.config.callerApprovalPath,
    booking: f.config.bookingApprovalPath, cancellation: f.config.bookingApprovalPath, rescheduling: f.config.bookingApprovalPath,
  } };
  const flow = resultValue(ClinikoCallFlow.create(config));
  const keypad = new PrivateWorkflowKeypad({ callId: f.f.callId, sessionId: f.f.sessionId, owner: () => flow });
  assert.equal(keypad.claim(f.f.callId, f.f.sessionId), true); assert.equal(keypad.start(), true);
  const close = async () => { flow.dispose(); await f.close(); };
  return { ...f, flow, keypad, close, flowConfig: config };
}

test("E2E-384 private representative CallFlow routes fresh subject keypad proof through played consent to exactly one native booking", async context => {
  const f = await fixture();
  const diagnostic = verificationPhaseDiagnostics(context, f.f.session, verificationCanaries[2]!, f.r.owner);
  try {
    assert.equal(f.keypad.blocked(), false);
    resultValue(await f.flow.chooseRepresentative("book", f.config.representative));
    assert.equal(f.keypad.blocked(), true); assert.equal(f.r.mail.length, 0);
    assert.equal(f.flow.beginVerification(), true);
    const deadline = Date.now() + 5000;
    while (!f.r.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(f.r.mail[0]?.email, "subject-one-private@example.test");
    for (const digit of f.r.mail[0]!.code) assert.equal(await f.keypad.accept(digit), "pending");
    assert.equal(await f.keypad.accept("#"), "verified"); assert.equal(f.keypad.blocked(), false);
    const reception = new TextReception(f.f.ledger, f.f.policies, f.flow);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception, undefined, undefined, undefined, f.f.ledger);
    async function play() {
      const pending = (await f.f.state()).pendingPresentationId!; assert.ok(pending);
      resultValue(await f.f.runtime.startPresentation(f.f.callId, pending, f.f.sessionId, verificationNow));
      resultValue(await f.f.runtime.resolvePresentation(f.f.callId, pending, "played", f.f.sessionId, verificationNow));
    }
    if ((await f.f.state()).pendingPresentationId) await play();
    resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.f.turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow })); await play();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.f.turn("select"), choice: 1, now: verificationNow }));
    assert.equal(f.requests.length, 0); const action = Object.values((await f.f.state()).actions)[0]!;
    assert.ok(action, `booking selection: ${(await f.f.state()).callerMessages.at(-1)}; verification phases: ${diagnostic()}`);
    await play(); resultValue(await reception.affirm(f.f.scope, f.f.turn("affirm", "Yes"), action.key, action.digest, verificationNow));
    await reception.drain(f.f.scope, f.f.callId, verificationNow);
    assert.equal((await f.f.state()).actions[action.key]!.status, "committed");
    assert.equal(f.requests.filter(row => row.path === "/v1/individual_appointments").length, 1);
    const publicText = JSON.stringify(await f.flow.publicIntentContext());
    for (const secret of [f.r.identity.firstName, f.r.identity.lastName, f.r.identity.dateOfBirth, f.r.mail[0]!.email, f.r.mail[0]!.code, f.config.representative.selectionRef]) assert.equal(publicText.includes(secret), false);
    assert.equal((await f.flow.choose("cancel")).ok, false, "a new operation cannot silently select the caller as patient");
    assert.equal(f.r.mail.length, 1);
    f.flow.dispose(); assert.equal(f.flow.closed, true);
    assert.equal((await f.r.owner.verifier(f.config.representative.selectionRef, f.r.lifetime.signal)).ok, false);
    assert.ok(await f.f.session.verified(), "disposing the subject route does not dispose the independent actor");
  } finally { await f.close(); }
});

test("E2E-384 self-only task process cannot implicitly authorize a related-person workflow", async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.flow.chooseRepresentative("book", f.config.representative)).ok, false);
    assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("E2E-384 private representative CallFlow refuses selection injected through ordinary constructor configuration", async () => {
  const f = await fixture();
  let unexpected: ClinikoCallFlow | undefined;
  try {
    const injectedConfig = { ...f.flowConfig, representative: f.config.representative };
    const result = ClinikoCallFlow.create(injectedConfig);
    if (result.ok) unexpected = result.value;
    assert.equal(result.ok, false, "the private route must own subject selection explicitly");
    assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0);
  } finally { unexpected?.dispose(); await f.close(); }
});

test("E2E-384 private representative CallFlow rejects wrong operation, forged selection and revision drift before sending a subject code", async () => {
  for (const fault of ["operation", "reference", "revision"] as const) {
    const f = await fixture();
    try {
      const selected = { ...f.config.representative, ...(fault === "reference" ? { selectionRef: "forged" } : {}) };
      const result = await f.flow.chooseRepresentative(fault === "operation" ? "cancel" : "book", selected, undefined, fault === "revision" ? 999 : undefined);
      assert.equal(result.ok, false); assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0);
      assert.equal(f.flow.workflow, undefined); assert.ok(await f.f.session.verified());
    } finally { await f.close(); }
  }
});
