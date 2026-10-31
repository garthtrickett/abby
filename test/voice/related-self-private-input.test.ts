// E2E-387: explicit native caller task after an independently approved related-person task.
import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { PrivateRepresentativeVoiceInput } from "../../src/standalone/private-representative-voice-input.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import type { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { relatedSelfTaskSequenceFixture } from "../support/related-self-task-sequence.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(check(), true);
}

async function fixture(approval: "approved" | "missing" | "denied" = "approved") {
  const f = await relatedSelfTaskSequenceFixture(), lifetime = new AbortController();
  const prompts: string[] = [], fields: string[] = [], transcripts: string[] = [];
  let sequence = 0;
  const keypad = new PrivateWorkflowKeypad({ callId: f.base.f.callId, sessionId: f.base.f.sessionId, owner: () => f.flow });
  const input = new PrivateRepresentativeVoiceInput({ callId: f.base.f.callId, sessionId: f.base.f.sessionId, input: keypad,
    owner: () => f.flow.representativeInputOwner, signal: lifetime.signal, present: async text => { prompts.push(text); return true; },
    ...(approval !== "missing" ? { canUseCallerInput: (previous: ClinikoRepresentativeCallOwner) =>
      approval === "approved" && f.flow.canUseCallerInputAfter(previous) } : {}),
    transcriptionFactory: sessionId => ({ accept: async () => ok([]), flush: async generation => {
      const text = fields.shift(); assert.ok(text); transcripts.push(text);
      return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `private-${transcripts.length}`, text, quality: "clear" as const }]);
    } }), mediaOptions: { speechStartMs: 20, silenceMs: 100 } });
  assert.equal(input.claim(f.base.f.callId, f.base.f.sessionId), true); assert.equal(input.start(), true);
  const frame = async (voiced: boolean) => {
    const bytes = new Uint8Array(640), view = new DataView(bytes.buffer);
    if (voiced) for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 3000, true);
    return input.acceptMedia({ sessionId: f.base.f.sessionId, sequence: sequence++, capturedAt: new Date(Date.parse(f.now()) + sequence * 20).toISOString(), bytes });
  };
  const field = async (text: string) => {
    const count = prompts.length; fields.push(text); assert.equal(await frame(true), "pending");
    for (let n = 0; n < 5; n++) assert.equal(await frame(false), "pending");
    await until(() => prompts.length > count); await new Promise<void>(resolve => setImmediate(resolve));
  };
  const related = async () => {
    const owner = await f.prepareRelated(); assert.equal(input.blocked(), true); await f.base.waitForMail(1);
    for (const digit of f.base.mail[0]!.code) assert.equal(await input.accept(digit), "pending");
    assert.equal(await input.accept("#"), "pending"); await until(() => prompts.length === 2);
    await field(f.base.r.identity.firstName); await field(f.base.r.identity.lastName); await field("5 March 1982");
    assert.equal(await input.accept("1"), "pending"); await f.base.waitForMail(2);
    for (const digit of f.base.mail[1]!.code) assert.equal(await input.accept(digit), "pending");
    assert.equal(await input.accept("#"), "verified"); assert.equal(input.blocked(), false);
    const first = await f.book(); assert.equal(first.status, "committed"); await f.nextWindow(); return { owner, first };
  };
  return { ...f, input, transcripts, related, close: async () => { input.stop(); lifetime.abort(); await f.close(); } };
}

test("private representative transport releases only an activated explicit native caller task to its original keypad", async () => {
  const f = await fixture();
  try {
    const { owner, first } = await f.related(), privateCount = f.transcripts.length;
    resultValue(await f.startSelf()); await f.play(); assert.equal(owner.closed, true);
    assert.equal(f.input.blocked(), true); assert.equal(f.flow.closed, false, "private routing must not dispose the new native owner");
    await f.base.waitForMail(3);
    for (const digit of f.base.mail[2]!.code) assert.equal(await f.input.accept(digit), "pending");
    assert.equal(await f.input.accept("#"), "verified"); assert.equal(f.input.blocked(), false);
    assert.equal(f.transcripts.length, privateCount, "native code verification opens no private ASR");
    assert.equal((await f.book()).status, "committed"); assert.equal(f.native.requests.length, 2);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

for (const observeIdle of [true, false])
test(`private transport keeps failed caller activation available for a fresh explicit workflow${observeIdle ? " without obsolete proof" : " before its next idle observation"}`, async () => {
  const f = await fixture();
  try {
    const { owner, first } = await f.related(), privateCount = f.transcripts.length;
    const complete = f.flow.completeWorkflowStart.bind(f.flow); f.flow.completeWorkflowStart = async () => false;
    assert.equal((await f.startSelf()).ok, false); await f.play();
    assert.equal(owner.closed, true); assert.equal(f.flow.representativeInputOwner, undefined);
    assert.equal(f.base.mail.length, 2, "unactivated owner must not issue a caller challenge");
    assert.equal(f.flow.closed, false); assert.equal(f.flow.verificationRequired, false);
    if (observeIdle) {
      assert.equal(f.input.blocked(), false, "idle caller input must permit a fresh explicit workflow");
      for (const digit of f.base.mail[1]!.code) assert.equal(await f.input.accept(digit), "pending");
      assert.equal(await f.input.accept("#"), "pending", "retired proof cannot verify the empty task");
    }
    assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.base.f.state()).actions[first.key], first);
    f.flow.completeWorkflowStart = complete;
    resultValue(await f.startSelf(false)); await f.play(); assert.equal(f.input.blocked(), true);
    await f.base.waitForMail(3);
    for (const digit of f.base.mail[2]!.code) assert.equal(await f.input.accept(digit), "pending");
    assert.equal(await f.input.accept("#"), "verified"); assert.equal(f.input.blocked(), false);
    assert.equal(f.transcripts.length, privateCount, "recovery must not open private ASR");
    assert.equal((await f.book()).status, "committed"); assert.equal(f.native.requests.length, 2);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});

for (const approval of ["missing", "denied"] as const)
test(`private transport without ${approval === "missing" ? "an installed" : "a positive"} caller-return decision fails closed`, async () => {
  const f = await fixture(approval);
  try {
    const { first } = await f.related(); resultValue(await f.startSelf()); await f.play();
    assert.equal(f.input.blocked(), true); assert.equal(f.flow.closed, true);
    assert.equal(await f.input.accept("1"), "failed"); assert.equal(f.native.requests.length, 1);
    assert.deepEqual((await f.base.f.state()).actions[first.key], first);
  } finally { await f.close(); }
});
