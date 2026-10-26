import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { PrivatePatientCorrectionInput } from "../../src/standalone/private-patient-correction-input.ts";
import { correctionTasksFixture } from "../support/patient-correction-tasks.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(check(), true, "expected private correction stage");
  await new Promise(resolve => setImmediate(resolve));
}

async function fixture() {
  const f = await correctionTasksFixture(), lifetime = new AbortController();
  const prompts: string[] = [], fields: string[] = [], sessions: string[] = [];
  let frames = 0;
  const input = new PrivatePatientCorrectionInput({ callId: f.callId, sessionId: f.sessionId, owner: () => f.flow,
    signal: lifetime.signal, present: async text => { prompts.push(text); return true; },
    mediaOptions: { speechStartMs: 20, silenceMs: 100 }, transcriptionFactory: sessionId => {
      sessions.push(sessionId);
      return { accept: async () => ok([]), flush: async generation => {
        const text = fields.shift(); assert.ok(text);
        return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: crypto.randomUUID(), text, quality: "clear" as const }]);
      } };
    } });
  assert.equal(input.claim(f.callId, f.sessionId), true); assert.equal(input.start(), true);
  const frame = async (voiced: boolean) => {
    const bytes = new Uint8Array(640), view = new DataView(bytes.buffer);
    if (voiced) for (let i = 0; i < bytes.length; i += 2) view.setInt16(i, 3000, true);
    return input.acceptMedia({ sessionId: f.sessionId, sequence: frames++,
      capturedAt: new Date(Date.parse(verificationNow) + frames * 20).toISOString(), bytes });
  };
  const verify = async () => {
    const before = prompts.length;
    for (const digit of f.mail.at(-1)!.code) assert.equal(await input.accept(digit), "pending");
    assert.equal(await input.accept("#"), "pending");
    await until(() => prompts.length > before && prompts.at(-1)!.includes("accept these privacy"));
    assert.equal(f.flow.verificationRequired, false); assert.equal(input.blocked(), true);
  };
  const collect = async (city: string) => {
    await input.accept("1"); await until(() => prompts.at(-1)!.includes("For city, enter 9"));
    await input.accept("9"); await input.accept("#"); await until(() => prompts.at(-1)!.includes("corrected city"));
    fields.push(city); await frame(true); for (let i = 0; i < 5; i++) await frame(false);
    await until(() => prompts.at(-1)!.includes("correct another field"));
    await input.accept("2"); await until(() => prompts.at(-1)!.includes("correction is ready for review"));
    assert.equal(await input.accept("#"), "verified"); assert.equal(input.blocked(), false);
  };
  return { ...f, input, prompts, sessions, frame, verify, collect, get patient() { return f.patient; },
    closeInput: async () => { input.stop(); lifetime.abort(); await f.closeTasks(); } };
}

test("E2E-381 a new correction task retires the private ready state, fields and consent before its fresh code", async () => {
  const f = await fixture(), cities = ["First Private Transport Town", "Second Private Transport Town"];
  try {
    await f.start(); await f.verify(); await f.collect(cities[0]!);
    const first = await f.commit(); assert.equal(first.status, "committed"); assert.equal(f.sessions.length, 1);
    await f.start(); assert.equal(f.input.blocked(), true);
    await f.frame(true); await f.frame(false); assert.equal(f.sessions.length, 1, "code entry never opens transcription");
    await f.verify(); assert.equal(f.flow.patientCorrectionRef, undefined);
    await f.input.accept("2"); await f.frame(true); await f.frame(false);
    assert.equal(f.flow.patientCorrectionRef, undefined, "prior field consent cannot prepare the new correction");
    assert.equal(f.sessions.length, 1);
    await f.collect(cities[1]!); const second = await f.commit(); assert.equal(second.status, "committed");
    assert.equal(f.mail.length, 2); assert.equal(f.reviews(), 2); assert.notEqual(first.key, second.key);
    assert.deepEqual(f.patches, cities.map(city => ({ city }))); assert.equal(f.patient.city, cities[1]);
    assert.equal(new Set(f.sessions).size, 2, "a new task gets a fresh private transcription session");
    assert.deepEqual((await f.state()).actions[first.key], first);
    for (const value of [...cities, ...f.mail.map(mail => mail.code)]) assert.equal(JSON.stringify(await f.state()).includes(value), false);
  } finally { await f.closeInput(); }
});

test("E2E-381 new-task private code entry preserves a prior correction when current patient permission is denied", async () => {
  const f = await fixture();
  try {
    await f.start(); await f.verify(); await f.collect("Private Permission Transport Town");
    const first = await f.commit(); assert.equal(first.status, "committed");
    await f.start(); f.setPermitted(false); assert.equal(f.input.blocked(), true);
    for (const digit of f.mail.at(-1)!.code) assert.equal(await f.input.accept(digit), "pending");
    assert.equal(await f.input.accept("#"), "pending"); assert.equal(f.flow.verificationRequired, true);
    await f.frame(true); await f.frame(false); assert.equal(f.sessions.length, 1);
    assert.equal(f.patches.length, 1); assert.equal(f.reviews(), 1);
    assert.deepEqual((await f.state()).actions[first.key], first);
  } finally { await f.closeInput(); }
});

test("E2E-381 private correction terms admit only a fresh task while preserving its retired committed action", async () => {
  const f = await correctionTasksFixture();
  try {
    await f.start(); const first = await f.correct("Private Core Prompt Town"); assert.equal(first.status, "committed");
    assert.equal((await f.runtime.privateCorrectionPrompt(f.callId, crypto.randomUUID(), f.sessionId, verificationNow)).ok, false,
      "a committed current correction cannot return to editable fields");
    await f.start(); assert.equal((await f.flow.submitCode(f.mail.at(-1)!.code)).verified, true);
    assert.deepEqual((await f.state()).previousTaskActionKeys, [first.key]);
    const next = await f.runtime.privateCorrectionPrompt(f.callId, crypto.randomUUID(), f.sessionId, verificationNow);
    assert.equal(next.ok, true); assert.deepEqual((await f.state()).actions[first.key], first);
  } finally { await f.closeTasks(); }
});

test("E2E-381 retiring a first correction never makes an uncertain current correction editable", async () => {
  const f = await correctionTasksFixture();
  try {
    await f.start(); const first = await f.correct("Private First Prompt Town"); assert.equal(first.status, "committed");
    await f.start(); f.loseResponse(); const second = await f.correct("Private Current Prompt Town");
    assert.ok(["uncertain", "needsReview"].includes(second.status));
    assert.equal((await f.runtime.privateCorrectionPrompt(f.callId, crypto.randomUUID(), f.sessionId, verificationNow)).ok, false);
    assert.deepEqual((await f.state()).actions[first.key], first); assert.deepEqual((await f.state()).actions[second.key], second);
    assert.equal(f.patches.length, 2); assert.equal(f.reviews(), 2);
  } finally { await f.closeTasks(); }
});
