import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { TimerPort } from "../../src/voice/timer.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const now = "2026-09-29T10:00:00.000Z";
const number = "+6125550199";
const sharedNumber = "+6125550200";
const scope = { tenantId: "silence-tenant", clinicId: "silence-clinic", locationId: "main" };

function manualTimer() {
  let next = 0;
  const scheduled = new Map<number, () => void>();
  const timer: TimerPort = {
    schedule(callback) { const id = ++next; scheduled.set(id, callback); return id; },
    cancel(handle) { scheduled.delete(handle as number); },
  };
  function fire(): void {
    assert.equal(scheduled.size, 1, "exactly one silence or playback deadline is active");
    const [id, callback] = scheduled.entries().next().value as [number, () => void];
    scheduled.delete(id);
    callback();
  }
  return { timer, scheduled, fire };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(predicate(), "expected call transition completed");
}

function fixture(shared = false) {
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  const event = { key: { accountRef: accountSid, providerCallRef: callSid },
    dialedNumber: shared ? sharedNumber : number, receivedAt: now };
  const timer = manualTimer();
  const sent: Record<string, unknown>[] = [];
  const spoken: string[] = [];
  let stops = 0;
  let closes = 0;
  const closeKinds: string[] = [];
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
    { accountRef: accountSid, dialedNumber: sharedNumber, ...scope, spokenName: "Main Street", routeVersion: "v1" },
    { accountRef: accountSid, dialedNumber: sharedNumber, ...scope, locationId: "north",
      spokenName: "Northside", routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const call = new TwilioConnectedCall({ event, sessionId: "session", ledger, intake,
    fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
      ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
    ...syntheticSpeech({ synthesis: { async *stream(text) {
      spoken.push(text);
      const bytes = new Uint8Array(640);
      const samples = new DataView(bytes.buffer);
      for (let index = 0; index < bytes.byteLength / 2; index += 1) {
        samples.setInt16(index * 2, Math.round(Math.sin(index / 9) * (1_000 + spoken.length * 2_000)), true);
      }
      yield bytes;
    } }, transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } } }),

    streamStartedAt: now, now: () => now, silenceTimer: timer.timer,
    onCallStop: () => { stops += 1; }, closeTransport: kind => { closes += 1; closeKinds.push(kind); },
    send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; },
  });
  let sequence = 1;
  async function receive(value: Record<string, unknown>) {
    return call.receive(JSON.stringify({ ...value, sequenceNumber: String(sequence++), streamSid }));
  }
  async function start() {
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
    assert.ok((await call.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }))).ok);
    const result = await receive({ event: "start", start: { accountSid, callSid, streamSid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
    assert.ok(result.ok && result.value.kind === "started");
    assert.deepEqual(sent.map(item => item.event), ["media", "mark"]);
    return result;
  }
  async function mark(index: number) {
    const name = (sent[index]?.mark as { name: string }).name;
    const result = await receive({ event: "mark", mark: { name } });
    assert.ok(result.ok && result.value.kind === "played", result.ok ? "" : result.error.kind);
  }
  return { call, ledger, event, timer, sent, spoken, start, mark, receive,
    stops: () => stops, closes: () => closes, closeKinds };
}

test("E2E-070 silent caller receives one retry and a final notice, then the call closes", async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.timer.scheduled.size, 1, "greeting needs playback evidence");
  const staleGreetingDeadline = f.timer.scheduled.values().next().value as () => void;
  await f.mark(1);
  staleGreetingDeadline();
  assert.equal(f.timer.scheduled.size, 1, "a canceled playback timer cannot close the listening call");
  const runtime = new CallRuntime(f.ledger, scope);
  const prematureFinal = await runtime.silenceTimeout(callIdFor(f.event.key), "session", "final", now);
  assert.ok(!prematureFinal.ok);
  assert.equal(prematureFinal.error.kind, "invalidTransition");
  f.timer.fire();
  await until(() => f.sent.length === 4);
  assert.deepEqual(f.sent.map(item => item.event), ["media", "mark", "media", "mark"]);
  const afterRetry = await f.ledger.read(callIdFor(f.event.key), scope);
  assert.ok(afterRetry.ok);
  assert.equal(afterRetry.value.processedTurnIds.length, 0, "silence never fabricates caller speech");
  assert.match(afterRetry.value.callerMessages.at(-1) ?? "", /still there/i);
  await f.mark(3);
  const repeatedRetry = await runtime.silenceTimeout(callIdFor(f.event.key), "session", "retry", now);
  assert.ok(!repeatedRetry.ok);
  assert.equal(repeatedRetry.error.kind, "invalidTransition");
  f.timer.fire();
  await until(() => f.sent.length === 6);
  assert.equal(f.spoken.length, 3);
  assert.match(f.spoken[1]!, /still there/i);
  assert.match(f.spoken[2]!, /end this call/i);
  assert.equal(new Set(f.sent.filter(item => item.event === "media")
    .map(item => (item.media as { payload: string }).payload)).size, 3,
  "greeting, retry and final notice are distinct media payloads");
  const afterFinal = await f.ledger.read(callIdFor(f.event.key), scope);
  assert.ok(afterFinal.ok);
  assert.match(afterFinal.value.callerMessages.at(-1) ?? "", /end this call/i);
  await f.mark(5);
  assert.equal(f.stops(), 1);
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.closeKinds, ["normal"]);
  assert.equal(f.timer.scheduled.size, 0);
  const ended = await f.ledger.read(callIdFor(f.event.key), scope);
  assert.ok(ended.ok);
  assert.equal(ended.value.lifecycle, "ended");
  assert.equal(ended.value.terminal?.reason, "sessionClosed");
  assert.equal(ended.value.processedTurnIds.length, 0);
});

test("E2E-070 unacknowledged greeting reaches a deadline without a fabricated retry", async () => {
  const f = fixture();
  await f.start();
  f.timer.fire();
  await until(() => f.closes() === 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.closeKinds, ["failure"]);
  assert.equal(f.timer.scheduled.size, 0);
  const ended = await f.ledger.read(callIdFor(f.event.key), scope);
  assert.ok(ended.ok);
  assert.equal(ended.value.lifecycle, "ended");
  assert.equal(ended.value.processedTurnIds.length, 0);
});

test("E2E-070 shared-number choice retries once and closes without binding a location", async () => {
  const f = fixture(true);
  const started = await f.start();
  assert.ok(started.ok && started.value.kind === "started" && started.value.value.kind === "locationChoice");
  await f.mark(1);
  f.timer.fire();
  await until(() => f.sent.length === 4);
  const retry = await f.ledger.findPendingLocation(callIdFor(f.event.key));
  assert.ok(retry.ok && retry.value);
  assert.equal(retry.value.prompt?.status, "queued");
  assert.equal(retry.value.choiceEvidence, undefined);
  await f.mark(3);
  f.timer.fire();
  await until(() => f.sent.length === 6);
  await f.mark(5);
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.closeKinds, ["normal"]);
  assert.equal(f.timer.scheduled.size, 0);
  const ended = await f.ledger.findPendingLocation(callIdFor(f.event.key));
  assert.ok(ended.ok && ended.value);
  assert.equal(ended.value.status, "expired");
  assert.equal(ended.value.choiceEvidence, undefined);
});

test("E2E-070 caller speech cancels the silence deadline", async () => {
  const f = fixture();
  await f.start();
  await f.mark(1);
  for (let index = 0; index < 2; index += 1) {
    const result = await f.receive({ event: "media", media: { track: "inbound", chunk: String(index + 1),
      timestamp: String(index * 20), payload: Buffer.alloc(160, 0x9f).toString("base64") } });
    assert.ok(result.ok && result.value.kind === "media");
  }
  assert.equal(f.timer.scheduled.size, 0);
  assert.equal(f.sent.length, 2, "no idle notice starts while the caller is speaking");
  await f.call.disconnect();
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.closeKinds, []);
  assert.equal(f.timer.scheduled.size, 0);
});

test("E2E-070 final notice without playback evidence closes at its deadline", async () => {
  const f = fixture();
  await f.start();
  await f.mark(1);
  f.timer.fire();
  await until(() => f.sent.length === 4);
  await f.mark(3);
  f.timer.fire();
  await until(() => f.sent.length === 6);
  f.timer.fire();
  await until(() => f.closes() === 1);
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.closeKinds, ["failure"]);
  assert.equal(f.timer.scheduled.size, 0);
  const ended = await f.ledger.read(callIdFor(f.event.key), scope);
  assert.ok(ended.ok);
  assert.equal(ended.value.lifecycle, "ended");
  assert.equal(Object.values(ended.value.presentations).at(-1)?.status, "unproven");
  assert.equal(ended.value.processedTurnIds.length, 0);
});

test("E2E-070 a stalled partial speech onset cannot keep the call open indefinitely", async () => {
  const f = fixture();
  await f.start();
  await f.mark(1);
  const partial = await f.receive({ event: "media", media: { track: "inbound", chunk: "1",
    timestamp: "0", payload: Buffer.alloc(160, 0x9f).toString("base64") } });
  assert.ok(partial.ok && partial.value.kind === "media" && partial.value.value.kind === "listening");
  f.timer.fire();
  await until(() => f.timer.scheduled.size === 1);
  assert.equal(f.closes(), 0);
  f.timer.fire();
  await until(() => f.closes() === 1);
  assert.deepEqual(f.closeKinds, ["failure"]);
  assert.equal(f.sent.length, 2, "a partial onset is never treated as a completed caller turn");
});
