import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { SharedNumberVoiceCall } from "../../src/voice/shared-number-voice-call.ts";
import { MediaTurnController } from "../../src/voice/media-turn-controller.ts";
import type { MediaFrame, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { PlaybackPort } from "../../src/voice/voice-session.ts";

const now = "2026-09-28T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1_000).toISOString();
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres", outputPort?: PlaybackPort) {
  const id = `${kind}-voice-handoff-${++sequence}`;
  const main = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const north = { ...main, locationId: "north" };
  const accountRef = `account-${id}`;
  let current = now;
  const sharedNumber = "+6125550101";
  const singleNumber = "+6125550102";
  const host = new ReferenceNumberRoutingHost([
    { accountRef, dialedNumber: sharedNumber, ...main, spokenName: "Main Street", routeVersion: "v1" },
    { accountRef, dialedNumber: sharedNumber, ...north, spokenName: "Northside", routeVersion: "v1" },
    { accountRef, dialedNumber: singleNumber, ...main, routeVersion: "v1" },
  ]);
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested) : new MemoryLedger();
  const policy = kind === "postgres"
    ? new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", async () => ok(true))
    : new MemoryPolicyStore("execute", () => current, async () => ok(true));
  let policyReads = 0;
  let policyGate: Readonly<{ entered: () => void; release: Promise<void> }> | undefined;
  const router = new ClinicPolicyRouter(host, { async read(scope) {
    policyReads += 1;
    const gate = policyGate;
    policyGate = undefined;
    if (gate) { gate.entered(); await gate.release; }
    return policy.read(scope);
  } });
  const admission = new CallAdmissionService(ledger, router.resolve, () => current, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => current);
  const patient = { scope: north, patientRef: "patient", verificationRef: "verified", expiresAt: at(3_600) };
  const offer = { scope: north, offerRef: "offer", serviceRef: "physio", startsAt: at(172_800), expiresAt: at(3_600) };
  const clinic = new ReferenceClinicHost([patient], [offer]);
  const reception = new TextReception(ledger, policy, clinic);
  const queued: Array<{ id: string; text: string }> = [];
  const playback: PlaybackPort = outputPort ?? {
    async enqueue(id, text) { queued.push({ id, text }); return "queued"; },
    async clear() { return true; },
  };
  const event = (dialedNumber: string, ref: string) =>
    ({ key: { accountRef, providerCallRef: `${id}-${ref}` }, dialedNumber, receivedAt: now });
  let wrongFactoryScope = false;
  const call = (inbound: ReturnType<typeof event>) => new SharedNumberVoiceCall(inbound, "session", ledger, intake, playback,
    (receipt, sessionId, port) => new VoiceSession(receipt.callId, sessionId,
      wrongFactoryScope ? main : receipt.scope, ledger, reception, port, async turn => ok(
        turn.text.startsWith("Book") ? { kind: "book" as const, verificationRef: "verified", offerRef: "offer" }
          : { kind: "affirm" as const })));
  return { main, north, ledger, policy, clinic, queued, call, event, sharedNumber, singleNumber,
    policyReads: () => policyReads, setWrongFactoryScope(value: boolean) { wrongFactoryScope = value; },
    setTime(value: string) { current = value; },
    holdNextPolicyRead() {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const releasePromise = new Promise<void>(resolve => { release = resolve; });
      policyGate = { entered, release: releasePromise };
      return { entered: enteredPromise, release };
    } };
}

for (const kind of kinds) {
  test(`${kind}: synthesized chunk playback needs exact completion before a booking affirmation`, async () => {
    const sent: Array<{ id: string; sequence: number }> = [];
    const finished: Array<{ id: string; sequence: number }> = [];
    const playback = new StreamedPlaybackPort({ async *stream() {
      yield new Uint8Array(640);
      yield new Uint8Array(640);
    } }, {
      async queueChunk(id, sequence) { sent.push({ id, sequence }); return "queued"; },
      async finishQueue(id, sequence) { finished.push({ id, sequence }); return "queued"; },
      async clear() { return true; },
    });
    const app = fixture(kind, playback);
    const call = app.call(app.event(app.sharedNumber, "streamed-playback"));
    const started = value(await call.begin(now));
    if (started.kind !== "locationChoice") throw new Error("choice expected");
    assert.deepEqual(sent.filter(item => item.id === started.prompt.playbackId).map(item => item.sequence), [0, 1]);
    const provePlayed = async (id: string, time: string) => value(await playback.acceptCompletion(
      { playbackId: id, lastSequence: 1, status: "played" },
      async event => (await call.acceptPlaybackResult(event.playbackId, event.status, time)).ok));
    await provePlayed(started.prompt.playbackId, at(1));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    const choiceGeneration = value(await call.speechStarted(at(2)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: choiceGeneration,
      utteranceId: "choice", text: "Northside", quality: "clear" }));
    app.setTime(at(3));
    const bound = value(await call.finishTurn(at(3)));
    if (bound.kind !== "locationBound") throw new Error("location not bound");
    const bookingGeneration = value(await call.speechStarted(at(4)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: bookingGeneration,
      utteranceId: "booking", text: "Book physio", quality: "clear" }));
    const planned = value(await call.finishTurn(at(5)));
    if (planned.kind !== "callerTurn") throw new Error("booking turn expected");
    const action = Object.values(planned.state.actions)[0];
    assert.ok(action);
    const details = value(await call.dispatchPending(at(6)));
    assert.equal(details.kind, "queued");
    assert.ok(details.playbackId);
    assert.deepEqual(finished.find(item => item.id === details.playbackId),
      { id: details.playbackId, sequence: 1 });
    assert.equal(app.clinic.bookings(app.north).length, 0);
    const premature = await playback.acceptCompletion(
      { playbackId: details.playbackId, lastSequence: 0, status: "played" }, async () => true);
    assert.ok(!premature.ok);
    assert.equal(premature.error.kind, "invalidPlaybackEvidence");
    const completion = { playbackId: details.playbackId, lastSequence: 1, status: "played" as const };
    const lostAcknowledgment = await playback.acceptCompletion(completion, async event => {
      value(await call.acceptPlaybackResult(event.playbackId, event.status, at(7)));
      return false;
    });
    assert.ok(!lostAcknowledgment.ok);
    assert.equal(lostAcknowledgment.error.kind, "settlementUnavailable");
    value(await playback.acceptCompletion(completion, async () => {
      const stored = value(await app.ledger.read(bound.receipt.callId, app.north));
      return stored.presentations[action.presentationId]?.status === "played";
    }));
    const affirmGeneration = value(await call.speechStarted(at(8)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: affirmGeneration,
      utteranceId: "affirm", text: "Yes", quality: "clear" }));
    const ready = value(await call.finishTurn(at(9)));
    if (ready.kind !== "callerTurn") throw new Error("affirmation turn expected");
    assert.equal(ready.state.actions[action.key]?.status, "ready");
    value(await call.drainEffects(at(10)));
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
  });

  test(`${kind}: shared-number voice call binds a location before booking and keeps one session`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "booking"));
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    assert.equal(app.queued[0]?.text, "Which location would you like? Please say Main Street or Northside.");
    assert.equal(app.policyReads(), 0);
    assert.equal(app.clinic.bookingEvidenceReads(), 0);
    assert.equal((await call.dispatchPending(now)).ok, true);
    assert.equal(app.queued.length, 1);
    if (started.kind !== "locationChoice") throw new Error("choice expected");
    value(await call.acceptPlaybackResult(started.prompt.playbackId, "played", now));
    const choiceGeneration = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: choiceGeneration,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    app.setTime(at(2));
    const bound = value(await call.finishTurn(at(2)));
    assert.equal(bound.kind, "locationBound");
    if (bound.kind !== "locationBound") throw new Error("bound expected");
    assert.deepEqual(bound.receipt.scope, app.north);
    assert.equal(bound.state.lifecycle, "active");
    assert.equal((await new CallRuntime(app.ledger, app.main).read(bound.receipt.callId)).ok, false);
    const bookingGeneration = value(await call.speechStarted(at(3)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: bookingGeneration,
      utteranceId: "booking", text: "Book physio", quality: "clear" }));
    const planned = value(await call.finishTurn(at(4)));
    assert.equal(planned.kind, "callerTurn");
    if (planned.kind !== "callerTurn") throw new Error("turn expected");
    const action = Object.values(planned.state.actions)[0];
    assert.ok(action);
    assert.equal(action.mutation.scope.locationId, app.north.locationId);
    assert.equal(action.status, "awaitingConfirmation");
    const details = value(await call.dispatchPending(at(5)));
    assert.equal(details.kind, "queued");
    value(await call.acceptPlaybackResult(details.playbackId!, "played", at(6)));
    const affirmGeneration = value(await call.speechStarted(at(7)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation: affirmGeneration,
      utteranceId: "affirm", text: "Yes", quality: "clear" }));
    const ready = value(await call.finishTurn(at(8)));
    assert.equal(ready.kind, "callerTurn");
    if (ready.kind !== "callerTurn") throw new Error("turn expected");
    assert.equal(ready.state.actions[action.key]?.status, "ready");
    assert.deepEqual(app.clinic.bookings(app.main), []);
    const committed = value(await call.drainEffects(at(9)));
    assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
  });

  test(`${kind}: single-location calls attach the ordinary voice session without a choice prompt`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "admin"));
    const started = value(await app.call(app.event(app.singleNumber, "single")).begin(now));
    assert.equal(started.kind, "admitted");
    if (started.kind !== "admitted") throw new Error("admission expected");
    assert.deepEqual(started.receipt.scope, app.main);
    assert.equal(started.state.lifecycle, "active");
    assert.deepEqual(app.queued, []);
  });

  test(`${kind}: wrong-scope full factory cannot attach and a correct retry keeps the bound choice`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "wrong-factory"));
    const started = value(await call.begin(now));
    assert.equal(started.kind, "locationChoice");
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    app.setWrongFactoryScope(true);
    const generation = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    app.setTime(at(2));
    const rejected = await call.finishTurn(at(2));
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.kind, "sessionUnavailable");
    assert.equal(app.policyReads(), 1);
    app.setWrongFactoryScope(false);
    const active = value(await call.resumeBound(at(3)));
    assert.equal(active.lifecycle, "active");
    assert.deepEqual(active.policy.scope, app.north);
  });

  test(`${kind}: disconnect during location choice closes the reservation and fences media`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "disconnect");
    const call = app.call(inbound);
    value(await call.begin(now));
    const ended = value(await call.end(at(1), "callerDisconnected"));
    if (!("status" in ended)) throw new Error("pending choice expected");
    assert.equal(ended.status, "expired");
    assert.equal(ended.closeEvidence?.reason, "callerDisconnected");
    assert.deepEqual(value(await call.end(at(2), "callerDisconnected")), ended);
    const later = await call.speechStarted(at(2));
    assert.ok(!later.ok);
    assert.equal(later.error.kind, "disconnected");
    assert.equal(value(await app.ledger.findAdmission(ended.callId)), null);
  });

  test(`${kind}: disconnect waits for a choice already binding and then ends the scoped call`, async () => {
    const app = fixture(kind);
    const call = app.call(app.event(app.sharedNumber, "choice-race"));
    value(await call.begin(now));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    const generation = value(await call.speechStarted(at(1)));
    value(call.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "location", text: "Northside", quality: "clear" }));
    app.setTime(at(2));
    const gate = app.holdNextPolicyRead();
    const finishing = call.finishTurn(at(2));
    await gate.entered;
    let ended = false;
    const ending = call.end(at(3), "callerDisconnected").then(result => { ended = true; return result; });
    await Promise.resolve();
    assert.equal(ended, false);
    gate.release();
    const bound = value(await finishing);
    assert.equal(bound.kind, "locationBound");
    const terminal = value(await ending);
    if (!("lifecycle" in terminal)) throw new Error("scoped call expected");
    assert.equal(terminal.lifecycle, "ended");
    assert.equal(terminal.terminal?.reason, "callerDisconnected");
    assert.deepEqual(terminal.policy.scope, app.north);
  });

  test(`${kind}: synthetic PCM frames close location, booking, and affirmation turns without direct turn calls`, async () => {
    const app = fixture(kind);
    const inbound = app.event(app.sharedNumber, "media-journey");
    const call = app.call(inbound);
    const started = value(await call.begin(now));
    if (started.kind !== "locationChoice") throw new Error("choice prompt expected");
    value(await call.acceptPlaybackResult(started.prompt.playbackId, "played", now));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    value(await app.policy.changeBookingEnabled(app.north, "0", true, "admin"));
    const utterances = ["Northside", "Book physio", "Yes"];
    let finalCount = 0;
    const transcription: TranscriptionPort = {
      async accept(_frame, generation) {
        return ok([{ kind: "partial", sessionId: "session", generation,
          utteranceId: "provider-utterance", text: utterances[finalCount]! }]);
      },
      async flush(generation) {
        return ok([{ kind: "segmentFinal", sessionId: "session", generation,
          utteranceId: "provider-utterance", text: utterances[finalCount++]!, quality: "clear" }]);
      },
    };
    const media = new MediaTurnController("session", call, transcription, { silenceMs: 100 });
    let sequence = 0;
    let offsetMs = 0;
    async function send(amplitude: number) {
      const bytes = new Uint8Array(640);
      const view = new DataView(bytes.buffer);
      for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
      const frame: MediaFrame = { sessionId: "session", sequence,
        capturedAt: new Date(Date.parse(now) + offsetMs + sequence * 20).toISOString(), bytes };
      sequence += 1;
      app.setTime(frame.capturedAt);
      return value(await media.acceptMedia(frame));
    }
    async function speak() {
      await send(2_000);
      await send(2_000);
      for (let i = 0; i < 4; i += 1) await send(0);
      const completed = await send(0);
      assert.equal(completed.kind, "turnCompleted");
      if (completed.kind !== "turnCompleted") throw new Error("final turn expected");
      return completed.value;
    }
    const bound = await speak();
    assert.equal(bound.kind, "locationBound");
    if (bound.kind !== "locationBound") throw new Error("bound call expected");
    assert.deepEqual(bound.receipt.scope, app.north);
    const choice = value(await app.ledger.findPendingLocation(bound.receipt.callId));
    const booked = await speak();
    assert.equal(booked.kind, "callerTurn");
    if (booked.kind !== "callerTurn") throw new Error("booking turn expected");
    assert.notEqual(choice?.choiceEvidence?.turnId, booked.state.processedTurnIds[0]);
    const action = Object.values(booked.state.actions)[0];
    assert.ok(action);
    assert.equal(action.status, "awaitingConfirmation");
    const details = value(await call.dispatchPending(at(2)));
    assert.equal(details.kind, "queued");
    value(await call.acceptPlaybackResult(details.playbackId!, "played", at(2)));
    offsetMs = 2_000;
    const affirmed = await speak();
    assert.equal(affirmed.kind, "callerTurn");
    if (affirmed.kind !== "callerTurn") throw new Error("affirmation turn expected");
    assert.equal(affirmed.state.actions[action.key]?.status, "ready");
    value(await call.drainEffects(at(3)));
    assert.equal(app.clinic.bookings(app.north).length, 1);
    assert.deepEqual(app.clinic.bookings(app.main), []);
    await media.stop();
    const ended = value(await call.end(at(4), "callerDisconnected"));
    assert.equal("lifecycle" in ended ? ended.lifecycle : "pending", "ended");
  });
}
