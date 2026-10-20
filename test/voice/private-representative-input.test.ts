import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { PrivateRepresentativeVoiceInput } from "../../src/standalone/private-representative-voice-input.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(check(), true);
}

async function fixture(held = false) {
  const f = await representativeCallOwnerFixture();
  const lifetime = new AbortController();
  let owner: ClinikoRepresentativeCallOwner | undefined;
  const prompts: string[] = [], fields: string[] = [], transcripts: string[] = [], sessions: string[] = [];
  let release: (played: boolean) => void = () => undefined, opened = 0, sequence = 0;
  const answers: { length: number; verified: boolean }[] = [];
  const keypad = new PrivateWorkflowKeypad({ callId: f.f.callId, sessionId: f.f.sessionId, owner: () => f.flow });
  const input = new PrivateRepresentativeVoiceInput({ callId: f.f.callId, sessionId: f.f.sessionId, input: keypad, owner: () => owner,
    signal: lifetime.signal, present: async text => {
      prompts.push(text);
      if (held && prompts.length === 1) return new Promise<boolean>(resolve => { release = resolve; });
      return true;
    }, transcriptionFactory: sessionId => {
      opened++; sessions.push(sessionId);
      return { accept: async () => ok([]), flush: async generation => {
        const text = fields.shift(); assert.ok(text); transcripts.push(text);
        return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `private-${transcripts.length}`, text, quality: "clear" as const }]);
      } };
    }, mediaOptions: { speechStartMs: 20, silenceMs: 100 } });
  assert.equal(input.claim(f.f.callId, f.f.sessionId), true); assert.equal(input.start(), true); assert.equal(input.blocked(), false);
  async function frame(voiced: boolean) {
    const bytes = new Uint8Array(640), view = new DataView(bytes.buffer);
    if (voiced) for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 3000, true);
    return input.acceptMedia({ sessionId: f.f.sessionId, sequence: sequence++, capturedAt: new Date(Date.parse(verificationNow) + sequence * 20).toISOString(), bytes });
  }
  async function field(text: string) {
    const count = prompts.length; fields.push(text);
    assert.equal(await frame(true), "pending");
    for (let silence = 0; silence < 5; silence++) assert.equal(await frame(false), "pending");
    await until(() => prompts.length > count);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { ...f, input, prompts, transcripts, sessions, answers, get opened() { return opened; }, release: (played: boolean) => release(played), frame, field,
    startOwner: async () => {
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config));
      const submit = owner.submitCallerCode.bind(owner);
      owner.submitCallerCode = async code => { const result = await submit(code); answers.push({ length: code.length, verified: result.verified }); return result; };
      assert.equal(input.blocked(), true); await until(() => prompts.length === 1);
    },
    close: async () => { input.stop(); lifetime.abort(); owner?.dispose(); await f.close(); } };
}

test("E2E-385 private representative input isolates both codes and three patient fields while reaching an actual delegated proof", async () => {
  const f = await fixture();
  try {
    await f.startOwner(); await f.waitForMail(1);
    await f.frame(true); await f.frame(false); assert.equal(f.opened, 0); assert.deepEqual(f.transcripts, []);
    for (const digit of f.mail[0]!.code) assert.equal(await f.input.accept(digit), "pending");
    assert.equal(await f.input.accept("#"), "pending"); assert.deepEqual(f.answers, [{ length: 6, verified: true }]); await until(() => f.prompts.length === 2);
    await f.field(f.r.identity.firstName); await f.field(f.r.identity.lastName); await f.field("5 March 1982");
    assert.match(f.prompts.at(-1)!, /Synthetic Subject Canaries/); assert.equal(f.mail.length, 1);
    assert.equal(f.input.blocked(), true); assert.equal(f.opened, 3);
    assert.equal(await f.input.accept("1"), "pending"); await f.waitForMail(2); await until(() => /Now verify/.test(f.prompts.at(-1)!));
    const privateCount = f.opened; await f.frame(true); await f.frame(false); assert.equal(f.opened, privateCount);
    for (const digit of f.mail[1]!.code) assert.equal(await f.input.accept(digit), "pending");
    assert.equal(await f.input.accept("#"), "verified"); assert.equal(f.input.blocked(), false);
    assert.equal(f.flow.workflow, "book"); assert.equal(f.writes, 0);
    assert.deepEqual(f.transcripts, [f.r.identity.firstName, f.r.identity.lastName, "5 March 1982"]);
    assert.equal(new Set(f.sessions).size, 3);
    const ordinary = JSON.stringify(await f.flow.publicIntentContext());
    for (const secret of [...f.transcripts, f.r.identity.dateOfBirth, ...f.mail.flatMap(row => [row.code, row.email])]) assert.equal(ordinary.includes(secret), false);
  } finally { await f.close(); }
});

test("E2E-385 private representative input requires played caller instructions before mail or transcription", async () => {
  const f = await fixture(true);
  try {
    await f.startOwner(); assert.equal(f.mail.length, 0); assert.equal(f.opened, 0);
    await f.input.accept("1"); await f.frame(true); assert.equal(f.mail.length, 0); assert.equal(f.opened, 0);
    f.release(false); await until(() => f.flow.closed); assert.equal(f.mail.length, 0); assert.equal(f.input.blocked(), true);
  } finally { await f.close(); }
});

test("E2E-385 private representative input can reset the patient readback before lookup and subject delivery", async () => {
  const f = await fixture();
  try {
    await f.startOwner(); await f.waitForMail(1);
    for (const digit of f.mail[0]!.code) await f.input.accept(digit); await f.input.accept("#"); assert.deepEqual(f.answers, [{ length: 6, verified: true }]); await until(() => f.prompts.length === 2);
    await f.field("Wrong"); await f.field("Person"); await f.field("5 March 1982");
    assert.equal(f.mail.length, 1); assert.equal(f.r.requests.length, 0);
    await f.input.accept("2"); await until(() => /first name/.test(f.prompts.at(-1)!));
    await f.field(f.r.identity.firstName); await f.field(f.r.identity.lastName); await f.field("5 March 1982");
    assert.equal(f.mail.length, 1); await f.input.accept("1"); await f.waitForMail(2); assert.equal(f.mail[1]!.email, "subject-one-private@example.test");
    assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
