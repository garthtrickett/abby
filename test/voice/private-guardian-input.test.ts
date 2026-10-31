// E2E-426: clinic-approved non-patient guardian records and separate patient proof.
import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { PrivateRepresentativeVoiceInput } from "../../src/standalone/private-representative-voice-input.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { guardianCallOwnerFixture } from "../support/guardian-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(check(), true);
}
async function fixture(holdChoice = false) {
  const f = await guardianCallOwnerFixture({ both: true }), lifetime = new AbortController();
  let owner: ClinikoRepresentativeCallOwner | undefined, opened = 0, sequence = 0, release: (played: boolean) => void = () => undefined;
  const prompts: string[] = [], fields: string[] = [], transcripts: string[] = [];
  const keypad = new PrivateWorkflowKeypad({ callId: f.base.f.callId, sessionId: f.base.f.sessionId, owner: () => f.flow });
  const input = new PrivateRepresentativeVoiceInput({ callId: f.base.f.callId, sessionId: f.base.f.sessionId, input: keypad, owner: () => owner,
    signal: lifetime.signal, present: async text => { prompts.push(text); return holdChoice && prompts.length === 1 ? new Promise<boolean>(resolve => { release = resolve; }) : true; },
    transcriptionFactory: sessionId => {
      opened++; return { accept: async () => ok([]), flush: async generation => {
        const text = fields.shift(); assert.ok(text); transcripts.push(text);
        return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: `private-guardian-${transcripts.length}`, text, quality: "clear" as const }]);
      } };
    }, mediaOptions: { speechStartMs: 20, silenceMs: 100 } });
  assert.equal(input.claim(f.base.f.callId, f.base.f.sessionId), true); assert.equal(input.start(), true);
  async function frame(voiced: boolean) {
    const bytes = new Uint8Array(640), view = new DataView(bytes.buffer);
    if (voiced) for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 3000, true);
    return input.acceptMedia({ sessionId: f.base.f.sessionId, sequence: sequence++, capturedAt: new Date(Date.parse(verificationNow) + sequence * 20).toISOString(), bytes });
  }
  return { f, input, prompts, transcripts, frame, get opened() { return opened; }, release: (played: boolean) => release(played),
    start: async () => { owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); assert.equal(input.blocked(), true); await until(() => prompts.length === 1); return owner; },
    field: async (text: string) => {
      const count = prompts.length; fields.push(text); assert.equal(await frame(true), "pending");
      for (let n = 0; n < 5; n++) assert.equal(await frame(false), "pending");
      await until(() => prompts.length > count); await new Promise<void>(resolve => setImmediate(resolve));
    },
    close: async () => { release(false); input.stop(); lifetime.abort(); owner?.dispose(); await f.close(); } };
}

test("private method choice and guardian code stay outside ASR before selected-patient proof", async () => {
  const h = await fixture();
  try {
    const owner = await h.start(); assert.match(h.prompts[0]!, /press one if you are a patient.*two.*not a patient/);
    assert.equal(h.f.base.mail.length, 0); assert.equal(h.f.reads.length, 0); await h.frame(true); await h.frame(false); assert.equal(h.opened, 0);
    assert.equal(await h.input.accept("9"), "pending"); assert.equal(owner.callerMethodChoiceRequired, true);
    assert.equal(await h.input.accept("2"), "pending"); await until(() => h.prompts.length === 2); await h.f.base.waitForMail(1);
    assert.equal(h.f.base.mail[0]!.email, h.f.state.guardianEmail); await h.frame(true); await h.frame(false); assert.equal(h.opened, 0);
    for (const digit of h.f.base.mail[0]!.code) await h.input.accept(digit); assert.equal(await h.input.accept("#"), "pending");
    await until(() => h.prompts.length === 3); assert.equal(owner.chooseCallerMethod("clinicPatient"), false);
    await h.field(h.f.base.r.identity.firstName); await h.field(h.f.base.r.identity.lastName); await h.field("5 March 2014");
    assert.equal(h.opened, 3); assert.equal(h.f.base.mail.length, 1);
    await h.input.accept("1"); await h.f.base.waitForMail(2); await until(() => /Now verify/.test(h.prompts.at(-1)!));
    await h.frame(true); await h.frame(false); assert.equal(h.opened, 3);
    for (const digit of h.f.base.mail[1]!.code) await h.input.accept(digit); assert.equal(await h.input.accept("#"), "verified");
    assert.equal(h.input.blocked(), false); assert.equal(h.f.flow.workflow, "book"); assert.equal(h.f.base.writes, 0);
    const publicData = JSON.stringify([await h.f.base.f.state(), await h.f.flow.publicIntentContext()]);
    for (const secret of [...h.transcripts, h.f.base.r.identity.dateOfBirth, ...h.f.base.mail.flatMap(row => [row.email, row.code])]) assert.equal(publicData.includes(secret), false);
    for (const { code } of h.f.base.mail) assert.equal(JSON.stringify(h.prompts).includes(code), false);
  } finally { await h.close(); }
});

test("unplayed identity-choice instructions cannot start either method or capture speech", async () => {
  const h = await fixture(true);
  try {
    const owner = await h.start(); await h.input.accept("2"); await h.frame(true); await h.frame(false);
    assert.equal(owner.callerMethodChoiceRequired, true); assert.equal(h.f.base.mail.length, 0); assert.equal(h.opened, 0); assert.equal(h.f.reads.length, 0);
    h.release(false); await until(() => owner.closed); assert.equal(h.input.blocked(), true); assert.equal(h.f.base.mail.length, 0);
  } finally { await h.close(); }
});

test("star at the private method choice closes the owner without either source receiving identity work", async () => {
  const h = await fixture();
  try {
    const owner = await h.start(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await h.input.accept("*"), "failed"); assert.equal(owner.closed, true); assert.equal(h.opened, 0);
    assert.deepEqual(h.f.counts, { identities: 0, authorities: 0 }); assert.equal(h.f.base.mail.length, 0);
  } finally { await h.close(); }
});
