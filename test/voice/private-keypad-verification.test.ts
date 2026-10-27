import assert from "node:assert/strict";
import test from "node:test";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { PrivateKeypadVerification } from "../../src/standalone/private-keypad-verification.ts";
import { intakeDeferred } from "../support/intake-edge.ts";
import { privateKeypadCallFixture } from "../support/private-keypad-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-294 signed admitted keypad code bypasses audio transcription, ordinary keypad choices, model and SAM then enables one protected read", async () => {
  const f = await privateKeypadCallFixture();
  try {
    await f.start(); assert.ok((await f.mark()).ok);
    for (let i = 0; i < 8; i++) assert.deepEqual(await f.media(i < 2), { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []); assert.equal(f.detailReads, 0);
    await f.delivered; assert.ok(f.mail[0]); const code = f.mail[0].code;
    await f.digit("9"); await f.digit("*");
    const answer = await f.code(code); assert.ok(answer.ok); assert.ok(await f.owner.verified());
    assert.equal(f.privateInput.blocked(), false); assert.equal(f.normalKeys, 0);
    await f.resume();
    for (let i = 0; i < 7; i++) assert.ok((await f.media(i < 2)).ok);
    assert.ok(f.transcripts.length > 0); assert.equal(f.modelTurns.length, 1); assert.equal(f.detailReads, 1);
    const state = await f.ledger.read(f.callId, f.f.scope); assert.ok(state.ok);
    const publicOutput = JSON.stringify([f.sent, f.spoken, f.modelTurns, state.value]);
    for (const privateValue of [...verificationCanaries, code]) assert.equal(publicOutput.includes(privateValue), false);
  } finally { await f.close(); }
});

test("E2E-294 star correction and malformed/overflow code attempts remain private and three denied submissions close the actual call", async () => {
  const f = await privateKeypadCallFixture();
  try {
    await f.start(); await f.mark();
    await f.digit("1"); await f.digit("*");
    assert.ok((await f.code("1234567")).ok); assert.ok((await f.code("12")).ok);
    const last = await f.code("ABC"); assert.deepEqual(last, { ok: false, error: { kind: "privateInputUnavailable" } });
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []); assert.equal(f.detailReads, 0); assert.equal(f.normalKeys, 0);
    assert.equal(await f.owner.verified(), undefined); assert.equal(f.privateInput.blocked(), true);
  } finally { await f.close(); }
});

test("E2E-294 current permission denial and disabled approval cannot turn a keypad code into a patient proof", async () => {
  for (const denial of ["permission", "approval"] as const) {
    const f = await privateKeypadCallFixture();
    try {
      await f.start(); await f.mark(); await f.delivered; assert.ok(f.mail[0]);
      if (denial === "permission") f.f.setPermitted(false); else await f.f.replaceApproval({ enabled: false });
      assert.ok((await f.code(f.mail[0].code)).ok); assert.equal(await f.owner.verified(), undefined);
      assert.equal(f.privateInput.blocked(), true); assert.equal(f.detailReads, 0); assert.deepEqual(f.transcripts, []);
    } finally { await f.close(); }
  }
});

test("E2E-294 disabled private mode preserves ordinary keypad routing and exact signatures reject forged entry before admission", async () => {
  const f = await privateKeypadCallFixture({ privateMode: false });
  try {
    assert.equal(f.ingress.answerWebhook({ ...f.webhook, signature: "forged" }).ok, false);
    assert.equal(f.ingress.authenticateStream({ ...f.upgrade, signature: "forged" }).ok, false);
    await f.start(); await f.mark(); assert.ok((await f.digit("1")).ok); assert.equal(f.normalKeys, 1); assert.deepEqual(f.mail, []);
  } finally { await f.close(); }
});


test("E2E-294 private wire arrival is retained while delivery/code work is held so late queued media and digits cannot escape after success", async () => {
  const released = intakeDeferred<boolean>();
  const f = await privateKeypadCallFixture({ delivery: { send: async () => released.promise } });
  try {
    await f.start(); await f.mark(); await f.delivered; assert.ok(f.mail[0]);
    for (const digit of f.mail[0].code) await f.digit(digit);
    const answering = f.digit("#"), queuedAudio = f.media(), queuedKey = f.digit("1");
    const oldQuiet = Array.from({ length: 25 }, () => f.media(false));
    released.resolve(true);
    assert.ok((await answering).ok);
    assert.deepEqual(await queuedAudio, { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(await queuedKey, { ok: true, value: { kind: "privateInput" } });
    for (const result of await Promise.all(oldQuiet)) assert.deepEqual(result, { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(await f.media(), { ok: true, value: { kind: "privateInput" } }, "earlier queued silence cannot end the fresh resume fence");
    assert.equal(f.privateInput.blocked(), false); assert.equal(f.normalKeys, 0); assert.deepEqual(f.transcripts, []);
    await f.resume();
    for (let i = 0; i < 7; i++) assert.ok((await f.media(i < 2)).ok);
    assert.equal(f.detailReads, 1);
  } finally { released.resolve(false); await f.close(); }
});

test("E2E-294 disconnect aborts held verification before the serialized event finishes and no late completion opens media or revives proof", async () => {
  const released = intakeDeferred<boolean>();
  const f = await privateKeypadCallFixture({ delivery: { send: async () => released.promise } });
  try {
    await f.start(); await f.mark(); await f.delivered; assert.ok(f.mail[0]);
    for (const digit of f.mail[0].code) await f.digit(digit);
    const answering = f.digit("#"), queuedAudio = f.media();
    const closing = f.call.disconnect();
    assert.equal((await answering).ok, false); assert.equal((await queuedAudio).ok, false); await closing;
    released.resolve(true);
    assert.equal(await f.owner.verified(), undefined); assert.equal(f.privateInput.blocked(), true);
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []); assert.equal(f.detailReads, 0);
  } finally { released.resolve(false); await f.close(); }
});

test("E2E-294 keypad entry is single-owner and wrong call/session or another admitted verifier cannot authorize it", async () => {
  const f = await privateKeypadCallFixture();
  try {
    assert.throws(() => new TwilioConnectedCall(f.callConfig), /invalid private input ownership/);
    const foreign = new PrivateKeypadVerification({ callId: f.callId, sessionId: f.sessionId, owner: () => f.f.session });
    assert.equal(foreign.claim("foreign", f.sessionId), false);
    assert.equal(foreign.claim(f.callId, "foreign"), false);
    assert.equal(foreign.claim(f.callId, f.sessionId), true); assert.equal(foreign.start(), false);
    await f.start(); await f.mark(); await f.delivered;
    assert.equal(f.privateInput.claim(f.callId, f.sessionId), false);
    assert.ok((await f.code(f.mail[0]!.code)).ok); assert.ok(await f.owner.verified());
  } finally { await f.close(); }
});

test("E2E-294 opening ordinary input supplies no lasting patient permission after current authority is revoked", async () => {
  const f = await privateKeypadCallFixture();
  try {
    await f.start(); await f.mark(); await f.delivered;
    assert.ok((await f.code(f.mail[0]!.code)).ok); assert.ok(await f.owner.verified());
    f.f.setPermitted(false);
    await f.resume();
    for (let i = 0; i < 7; i++) assert.ok((await f.media(i < 2)).ok);
    assert.equal(f.modelTurns.length, 1); assert.equal(f.detailReads, 0); assert.equal(await f.owner.verified(), undefined);
  } finally { await f.close(); }
});

test("E2E-294 code audio arriving after verification remains private until a fresh quiet interval", async () => {
  const f = await privateKeypadCallFixture();
  try {
    await f.start(); await f.mark(); await f.delivered; assert.ok((await f.code(f.mail[0]!.code)).ok);
    assert.deepEqual(await f.media(), { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(await f.media(), { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []);
  } finally { await f.close(); }
});


test("E2E-294 disconnected quiet frames cannot establish the continuous 500 ms private-audio resume interval", async () => {
  const f = await privateKeypadCallFixture();
  try {
    await f.start(); await f.mark(); await f.delivered; assert.ok((await f.code(f.mail[0]!.code)).ok);
    for (let i = 0; i < 25; i++) assert.deepEqual(await f.media(false, 100), { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(await f.media(), { ok: true, value: { kind: "privateInput" } });
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []);
    await f.resume();
    for (let i = 0; i < 7; i++) assert.ok((await f.media(i < 2)).ok);
    assert.equal(f.detailReads, 1);
  } finally { await f.close(); }
});

test("E2E-294 held private verification consumes ordered audio without blocking the call or opening public transcription", async () => {
  const released = intakeDeferred<boolean>();
  const f = await privateKeypadCallFixture({ delivery: { send: async () => released.promise } });
  let answering: ReturnType<typeof f.digit> | undefined;
  try {
    await f.start(); await f.mark(); await f.delivered;
    for (const digit of f.mail[0]!.code) await f.digit(digit);
    answering = f.digit("#");
    for (let frame = 0; frame < 100; frame++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const processed = await Promise.race([f.media(frame % 10 === 0), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("private audio must drain while verification remains held")), 500);
        })]);
        assert.deepEqual(processed, { ok: true, value: { kind: "privateInput" } });
      } finally { clearTimeout(timer); }
    }
    assert.equal(f.privateInput.blocked(), true);
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []); assert.equal(f.detailReads, 0);
    released.resolve(true); assert.ok((await answering).ok);
    assert.deepEqual(await f.media(), { ok: true, value: { kind: "privateInput" } }, "held private audio cannot satisfy the later resume fence");
    await f.resume();
    for (let frame = 0; frame < 7; frame++) assert.ok((await f.media(frame < 2)).ok);
    assert.equal(f.detailReads, 1); assert.equal(f.normalKeys, 0);
  } finally { released.resolve(false); await answering; await f.close(); }
});

test("E2E-294 pending private digits retain the shared 64-message admission bound", async () => {
  const released = intakeDeferred<boolean>();
  const f = await privateKeypadCallFixture({ delivery: { send: async () => released.promise } });
  let answering: ReturnType<typeof f.digit> | undefined;
  try {
    await f.start(); await f.mark(); await f.delivered;
    for (const digit of f.mail[0]!.code) await f.digit(digit);
    answering = f.digit("#");
    assert.deepEqual(await f.media(false), { ok: true, value: { kind: "privateInput" } });
    const queued = Array.from({ length: 64 }, () => f.digit("1"));
    const results = await Promise.all(queued);
    assert.ok(results.some(result => !result.ok && result.error.kind === "streamOverloaded"));
    assert.equal((await answering).ok, false); assert.equal(await f.owner.verified(), undefined);
    assert.equal(f.privateInput.blocked(), true); assert.equal(f.normalKeys, 0);
    assert.deepEqual(f.transcripts, []); assert.deepEqual(f.modelTurns, []); assert.equal(f.detailReads, 0);
  } finally { released.resolve(false); await answering; await f.close(); }
});
