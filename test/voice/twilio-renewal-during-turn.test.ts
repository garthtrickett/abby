import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import type { TimerPort } from "../../src/voice/timer.ts";

/** Manual clocks exercise lease boundaries without extending a production deadline. */
async function heldCallerFixture(beforeEffects?: () => Promise<void>, queuedBeforePending?: "quiet" | "voiced") {
  const base = Date.parse("2026-10-08T00:00:00.000Z"); let elapsed = 0;
  const now = () => new Date(base + elapsed).toISOString();
  const scope = { tenantId: "renewal-during-turn", clinicId: "clinic", locationId: "main" };
  const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`, streamSid = `MZ${"3".repeat(32)}`;
  const event = { key: { accountRef: accountSid, providerCallRef: callSid }, dialedNumber: "+6125550199", receivedAt: now() };
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: event.dialedNumber, ...scope, routeVersion: "v1" }]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, now);
  const host = new ReferenceClinicHost([], []), reception = new TextReception(ledger, policy, host);
  const scheduled = new Map<number, () => void>(); let timerId = 0;
  const leaseTimer: TimerPort = { schedule(callback) { const id = ++timerId; scheduled.set(id, callback); return id; }, cancel(id) { scheduled.delete(id as number); } };
  const attempts: string[] = [], sent: Record<string, unknown>[] = [];
  let entered!: () => void, release!: () => void, stops = 0;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const call = new TwilioConnectedCall({ event, sessionId: "session", ledger, intake,
    fullFactory: (receipt, sessionId, playback) => {
      const voice = new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
        async () => { entered(); await waiting; return ok({ kind: "clarify" }); }, undefined, () => elapsed);
      if (beforeEffects) {
        const drain = voice.drainVoiceEffects.bind(voice);
        voice.drainVoiceEffects = async now => { await beforeEffects(); return drain(now); };
      }
      return voice;
    },
    ...syntheticSpeech({ synthesis: { async *stream() { yield new Uint8Array(640); } }, transcription: {
      async accept() { return ok([]); }, async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
        utteranceId: "ordinary-booking", text: "I would like an appointment.", quality: "clear" }]); },
    } }), mediaOptions: { silenceMs: 100 }, streamStartedAt: now(), now, monotonicNow: () => elapsed, leaseTimer,
    onCallStop() { stops++; },
    onLeaseAttempt(outcome) { attempts.push(outcome.kind === "renewed" ? "renewed" : outcome.reason); },
    send(json) { sent.push(JSON.parse(json)); return "queued"; },
  });
  assert.ok((await call.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }))).ok);
  assert.ok((await call.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid, start: { accountSid, callSid, streamSid,
    tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }))).ok);
  const marker = sent.find(item => item.event === "mark")!.mark as { name: string };
  assert.ok((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid, mark: marker }))).ok);
  elapsed = 19_000;
  let final!: ReturnType<typeof call.receive>;
  for (let i = 0; i < 7; i++) {
    const received = call.receive(JSON.stringify({ event: "media", sequenceNumber: String(i + 3), streamSid,
      media: { track: "inbound", chunk: String(i + 1), timestamp: String(i * 20), payload: Buffer.alloc(160, i < 2 ? 0x9f : 0xff).toString("base64") } }));
    if (i < 6) assert.ok((await received).ok); else final = received;
  }
  let sequence = 10, chunk = 8;
  // Arrive in the same stack as the endpoint, before it reaches finishTurn.
  // This packet is already queued when interpretation becomes pending.
  const queuedPacket = queuedBeforePending ? call.receive(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
    media: { track: "inbound", chunk: String(chunk++), timestamp: "140",
      payload: Buffer.alloc(160, queuedBeforePending === "voiced" ? 0x9f : 0xff).toString("base64") } })) : undefined;
  await held;
  return { call, ledger, scope, attempts, sent, scheduled, final, release, queuedPacket,
    mark() {
      const mark = sent.filter(item => item.event === "mark").at(-1)!.mark;
      return call.receive(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid, mark }));
    },
    media(voiced = false) {
      const current = chunk++;
      return call.receive(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
        media: { track: "inbound", chunk: String(current), timestamp: String((current - 1) * 20),
          payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } }));
    },
    get stops() { return stops; },
    setTime(ms: number) { elapsed = ms; },
    fireRenewal() { const entry = scheduled.entries().next().value; assert.ok(entry); const [id, tick] = entry; scheduled.delete(id); tick(); },
    state: () => ledger.read(callIdFor(event.key), scope),
    async close() { release(); await final; await call.disconnect(); },
  };
}

test("E2E-141 pending caller interpretation consumes ordered silence without retaining a carrier backlog", async () => {
  const f = await heldCallerFixture();
  try {
    for (let frame = 0; frame < 100; frame++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const received = await Promise.race([f.media(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("quiet carrier audio must drain while caller interpretation is held")), 500);
        })]);
        assert.deepEqual(received, { ok: true, value: { kind: "media", value: { kind: "listening" } } });
      } finally { clearTimeout(timer); }
    }
    const pending = await f.state(); assert.ok(pending.ok); assert.equal(pending.value.processedTurnIds.length, 0);
    f.release(); assert.ok((await f.final).ok); assert.ok((await f.mark()).ok);
    for (let frame = 0; frame < 7; frame++) {
      const result = await f.media(frame < 2); assert.ok(result.ok, JSON.stringify(result));
    }
    const completed = await f.state(); assert.ok(completed.ok); assert.equal(completed.value.processedTurnIds.length, 2);
    assert.equal(f.stops, 0);
  } finally { await f.close(); }
});

test("E2E-141 silence queued before endpoint completion drains before later carrier packets", async () => {
  const f = await heldCallerFixture(undefined, "quiet");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = f.media();
    const results = await Promise.race([Promise.all([f.queuedPacket!, next]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the queued quiet predecessor must drain while interpretation remains held")), 500);
    })]);
    assert.deepEqual(results, [
      { ok: true, value: { kind: "media", value: { kind: "listening" } } },
      { ok: true, value: { kind: "media", value: { kind: "listening" } } },
    ]);
    for (let index = 0; index < 100; index++) assert.ok((await f.media()).ok);
    assert.equal(f.stops, 0);
    f.release(); assert.ok((await f.final).ok); assert.ok((await f.mark()).ok);
    for (let index = 0; index < 7; index++) assert.ok((await f.media(index < 2)).ok);
    const state = await f.state(); assert.ok(state.ok); assert.equal(state.value.processedTurnIds.length, 2);
  } finally { clearTimeout(timer); await f.close(); }
});

test("E2E-141 pending interpretation cannot skip queued speech or its separating silence", async () => {
  const f = await heldCallerFixture(undefined, "voiced");
  let settled = false;
  try {
    const quiet = f.media().then(result => { settled = true; return result; });
    await nextTick(); assert.equal(settled, false);
    f.release(); assert.ok((await f.final).ok); assert.ok((await f.queuedPacket!).ok); assert.ok((await quiet).ok);
    assert.ok((await f.mark()).ok);
    for (let index = 0; index < 7; index++) assert.ok((await f.media(index < 2)).ok);
    const state = await f.state(); assert.ok(state.ok); assert.equal(state.value.processedTurnIds.length, 2);
    assert.equal(f.stops, 0);
  } finally { await f.close(); }
});

test("E2E-141 queued voiced media retains the shared 64-message admission bound", async () => {
  const f = await heldCallerFixture(undefined, "voiced");
  try {
    const queued = Array.from({ length: 64 }, () => f.media());
    assert.equal(f.stops, 1);
    f.release();
    const results = await Promise.all([f.final, f.queuedPacket!, ...queued]);
    assert.ok(results.some(result => !result.ok && result.error.kind === "streamOverloaded"));
    const state = await f.state(); assert.ok(state.ok); assert.equal(state.value.lifecycle, "ended");
  } finally { await f.close(); }
});

test("E2E-141 renewal completes while caller interpretation is pending and the turn survives its initial lease", { timeout: 10_000 }, async () => {
  const f = await heldCallerFixture();
  try {
    f.setTime(20_000); f.fireRenewal(); await nextTick();
    assert.deepEqual(f.attempts, ["renewed"], "a pending caller turn must not queue the lease renewal");
    const renewed = await f.state(); assert.ok(renewed.ok);
    assert.equal(renewed.value.sessionLease?.version, 2);
    assert.equal(renewed.value.sessionLease?.expiresAt, "2026-10-08T00:00:50.000Z");
    assert.equal(f.sent.filter(item => item.event === "media").length, 1);
    assert.equal(renewed.value.processedTurnIds.length, 0);
    f.setTime(29_000); f.release();
    const result = await f.final;
    assert.ok(result.ok && result.value.kind === "media" && result.value.value.kind === "turnCompleted", JSON.stringify(result));
    const accepted = await f.state(); assert.ok(accepted.ok);
    assert.equal(accepted.value.processedTurnIds.length, 1);
    assert.equal(f.sent.filter(item => item.event === "media").length, 2);
    assert.equal(Object.keys(accepted.value.actions).length, 0);
  } finally { await f.close(); }
});

test("E2E-141 renewal cannot revive an expired lease while caller interpretation is pending", { timeout: 10_000 }, async () => {
  const f = await heldCallerFixture();
  try {
    f.setTime(29_000); f.fireRenewal(); await nextTick();
    assert.deepEqual(f.attempts, ["leaseLost"]);
    f.release(); await f.final; await f.call.disconnect();
    const ended = await f.state(); assert.ok(ended.ok);
    assert.equal(ended.value.lifecycle, "ended");
    assert.equal(f.sent.filter(item => item.event === "media").length, 1);
    assert.equal(f.stops, 1);
    assert.equal(f.scheduled.size, 0);
  } finally { await f.close(); }
});

test("E2E-141 a lease advance racing caller acceptance preserves that caller turn", { timeout: 10_000 }, async () => {
  const f = await heldCallerFixture();
  try {
    const apply = f.ledger.apply.bind(f.ledger); let armed = true;
    f.ledger.apply = async (...args: Parameters<typeof apply>) => {
      if (args[3].kind === "callerTurn" && armed) {
        armed = false; f.fireRenewal(); await nextTick();
        assert.deepEqual(f.attempts, ["renewed"]);
      }
      return apply(...args);
    };
    f.setTime(20_000); f.release();
    const result = await f.final;
    assert.ok(result.ok && result.value.kind === "media" && result.value.value.kind === "turnCompleted", JSON.stringify(result));
    const state = await f.state(); assert.ok(state.ok);
    assert.equal(state.value.sessionLease?.version, 2);
    assert.equal(state.value.processedTurnIds.length, 1);
    assert.equal(f.sent.filter(item => item.event === "media").length, 2);
  } finally { await f.close(); }
});

for (const renewFirst of [false, true]) test(`E2E-141 a concurrent conversation change still rejects caller acceptance (renewal ${renewFirst})`, { timeout: 10_000 }, async () => {
  const f = await heldCallerFixture();
  try {
    const apply = f.ledger.apply.bind(f.ledger); let armed = true;
    f.ledger.apply = async (...args: Parameters<typeof apply>) => {
      if (args[3].kind === "callerTurn" && armed) {
        armed = false;
        if (renewFirst) { f.fireRenewal(); await nextTick(); assert.deepEqual(f.attempts, ["renewed"]); }
        const runtime = new CallRuntime(f.ledger, f.scope);
        assert.ok((await runtime.beginSpeech(args[0], "session", "2026-10-08T00:00:20.000Z")).ok);
      }
      return apply(...args);
    };
    f.setTime(20_000); f.release();
    const result = await f.final;
    assert.ok(!result.ok && result.error.kind === "versionConflict", JSON.stringify(result));
    const state = await f.state(); assert.ok(state.ok);
    assert.equal(state.value.processedTurnIds.length, 0);
    assert.equal(f.sent.filter(item => item.event === "media").length, 1);
  } finally { await f.close(); }
});

for (const outcome of ["late response", "disconnect"] as const) test(`E2E-141 a pending lease renewal respects ${outcome}`, { timeout: 10_000 }, async () => {
  const f = await heldCallerFixture();
  let releaseRenewal = () => {};
  try {
    const apply = f.ledger.apply.bind(f.ledger); let entered = false;
    const waiting = new Promise<void>(resolve => { releaseRenewal = resolve; });
    f.ledger.apply = async (...args: Parameters<typeof apply>) => {
      if (args[3].kind === "sessionRenewed") { entered = true; await waiting; }
      return apply(...args);
    };
    f.setTime(20_000); f.fireRenewal(); await nextTick(); assert.equal(entered, true);
    let closing: Promise<unknown> | undefined, closed = false;
    if (outcome === "disconnect") {
      closing = f.call.disconnect().then(result => { closed = true; return result; });
      await nextTick(); assert.equal(f.stops, 1); assert.equal(closed, false, "disposal waits for the owned renewal");
    } else f.setTime(29_000);
    releaseRenewal(); await nextTick();
    if (outcome === "late response") assert.deepEqual(f.attempts, ["leaseLost"], "a late response must not reset an expired local deadline");
    f.release(); await f.final; await closing; await f.call.disconnect();
    const state = await f.state(); assert.ok(state.ok);
    assert.equal(state.value.lifecycle, "ended");
    assert.equal(state.value.processedTurnIds.length, 0);
    assert.equal(f.sent.filter(item => item.event === "media").length, 1);
    assert.equal(f.stops, 1);
    assert.equal(f.scheduled.size, 0);
  } finally { releaseRenewal(); await f.close(); }
});


test("E2E-141 completed caller interpretation still drains quiet carrier audio while effects are held", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await heldCallerFixture(async () => { entered(); await held; });
  try {
    f.release(); await ready;
    for (let frame = 0; frame < 100; frame++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const received = await Promise.race([f.media(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("quiet carrier audio must drain while completed-turn effects are held")), 500);
        })]);
        assert.deepEqual(received, { ok: true, value: { kind: "media", value: { kind: "listening" } } });
      } finally { clearTimeout(timer); }
    }
    const pending = await f.state(); assert.ok(pending.ok); assert.equal(pending.value.processedTurnIds.length, 1);
    release(); assert.ok((await f.final).ok); assert.ok((await f.mark()).ok);
    for (let frame = 0; frame < 7; frame++) {
      const received = await f.media(frame < 2); assert.ok(received.ok, JSON.stringify(received));
    }
    const completed = await f.state(); assert.ok(completed.ok); assert.equal(completed.value.processedTurnIds.length, 2);
    assert.equal(f.stops, 0);
  } finally { release(); await f.close(); }
});
