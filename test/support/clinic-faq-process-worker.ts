import assert from "node:assert/strict";
import { captureKnowledgeSnapshot } from "../../src/core/knowledge-evidence.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileClinicFAQs } from "../../src/standalone/owner-file-clinic-faqs.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { verificationNow } from "./caller-verification.ts";

export type FAQProcessConfig = Readonly<{ scope: LocationScope; faqPath: string; accountPath: string; policyVersion: string }>;
export type FAQProcessRequest = Readonly<{ op: "init"; config: FAQProcessConfig }> |
  Readonly<{ op: "fresh" }> | Readonly<{ op: "read" }> | Readonly<{ op: "close" }> |
  Readonly<{ op: "answer"; sourceRef: string; text: string }>;
export type FAQProcessRead = Readonly<{ pid: number; choices: readonly { sourceRef: string; approvedText: string; version: string }[];
  readKind: "ok" | "unavailable" }>;

let config: FAQProcessConfig | undefined;
let fixture: Awaited<ReturnType<typeof bookingCallFlowFixture>> | undefined;
let flow: ClinikoCallFlow | undefined;
let source: OwnerFileClinicFAQs | undefined;
let agent: CommandGateway | undefined;
let turnSequence = 0;

async function close() {
  flow?.dispose(); flow = undefined; source = undefined; agent = undefined;
  const owned = fixture; fixture = undefined; await owned?.close();
}
async function fresh() {
  assert.ok(config); await close();
  const selected = config;
  const directory = new OwnerFileAdminDirectory(selected.accountPath, selected.scope);
  let captured = false;
  fixture = await bookingCallFlowFixture({ scope: selected.scope, capturePolicy: async policy => {
    assert.equal(captured, false); captured = true;
    assert.deepEqual(policy.scope, selected.scope); assert.equal(policy.policyVersion, selected.policyVersion);
    const initial = new OwnerFileClinicFAQs({ path: selected.faqPath, scope: selected.scope,
      policyVersion: selected.policyVersion, policies: { read: async () => ok(policy) }, directory, clock: () => verificationNow });
    return { ...policy, knowledgeSnapshot: resultValue(await captureKnowledgeSnapshot(initial, selected.scope, verificationNow)) };
  } });
  assert.equal(captured, true, "the actual admitted call must capture the shared FAQ snapshot");
  fixture.flow.dispose();
  source = new OwnerFileClinicFAQs({ path: selected.faqPath, scope: selected.scope,
    policyVersion: selected.policyVersion, policies: fixture.policies, directory, clock: () => verificationNow });
  flow = resultValue(ClinikoCallFlow.create({ ...fixture.flowConfig, publicKnowledge: source }));
  const reception = new TextReception(fixture.ledger, fixture.policies, flow, undefined, undefined, undefined, flow, () => verificationNow);
  agent = new CommandGateway({ actorRef: "public-faq-agent", role: "agent", scope: fixture.scope }, fixture.policies, reception);
  return read();
}
async function read(): Promise<FAQProcessRead> {
  assert.ok(flow && fixture && source);
  const choices = (await flow.publicFAQChoices()).map(({ sourceRef, approvedText, version }) => ({ sourceRef, approvedText, version }));
  const current = await source.readKnowledge(fixture.scope, ["clinic-public-contact"]);
  assert.equal(fixture.posts, 0); assert.equal(fixture.mail.length, 0);
  return { pid: process.pid, choices, readKind: current.ok ? "ok" : "unavailable" };
}
async function dispatch(message: FAQProcessRequest) {
  if (message.op === "close") { await close(); return { closed: true }; }
  if (message.op === "init") { assert.equal(config, undefined); config = message.config; return fresh(); }
  if (message.op === "fresh") return fresh();
  if (message.op === "read") return read();
  assert.ok(fixture && agent);
  const turnId = `public-faq-${++turnSequence}`;
  resultValue(await agent.submit({ kind: "knowledge.answer.v2", turn: fixture.turn(turnId, "What is the published clinic information?"),
    sourceRefs: [message.sourceRef], proposedText: message.text, now: verificationNow }));
  const state = resultValue(await fixture.ledger.read(fixture.callId, fixture.scope));
  assert.equal(fixture.posts, 0); assert.equal(fixture.mail.length, 0);
  return { text: state.callerMessages.at(-1), accepted: state.knowledgeAnswers.some(answer => answer.turnId === turnId) };
}

// These are real long-lived OS processes. Requests serialize only their own
// fixture; the parent atomically changes files shared by both consumers.
let pending = Promise.resolve();
process.on("message", (message: { id: number; request: FAQProcessRequest }) => {
  pending = pending.then(async () => {
    try {
      const result = await dispatch(message.request);
      process.send?.({ id: message.id, result }, () => { if (message.request.op === "close") process.disconnect(); });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message : "FAQ worker failed" });
    }
  });
});
process.on("disconnect", () => { void close().finally(() => { process.exitCode = 0; }); });
