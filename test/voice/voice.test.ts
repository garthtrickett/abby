import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import type { TextReception } from "../../src/reference/text-reception.ts";
import type { PolicyStore } from "../../src/core/host.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { PlaybackPort } from "../../src/voice/voice-session.ts";

const now = "2026-09-28T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

class FakePlayback implements PlaybackPort {
  readonly queued: string[] = [];
  readonly cleared: string[] = [];
  sendResult: "queued" | "notSent" | "uncertain" = "queued";
  sendPromise?: Promise<"queued" | "notSent" | "uncertain">;
  enqueueStarted?: () => void;
  clearResult = true;

  async enqueue(id: string, _text: string): Promise<"queued" | "notSent" | "uncertain"> {
    this.queued.push(id);
    this.enqueueStarted?.();
    if (this.sendPromise) return this.sendPromise;
    return this.sendResult;
  }

  async clear(id: string): Promise<boolean> {
    this.cleared.push(id);
    return this.clearResult;
  }
}

async function fixture(kind: "memory" | "postgres", id: string, bookingEnabled: boolean) {
  const scope: LocationScope = { tenantId: `voice-tenant-${id}`, clinicId: `voice-clinic-${id}`, locationId: `voice-location-${id}` };
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `proof-${id}`, expiresAt: at(86_400) };
  const offer = { scope, offerRef: `offer-${id}`, serviceRef: "physio", startsAt: at(90_000), expiresAt: at(86_400) };
  const host = new ReferenceClinicHost([patient], [offer]);
  let ledger: LedgerStore;
  let policy: PolicyStore;
  let reception: TextReception;
  if (kind === "postgres") {
    assert.ok(db);
    ledger = new PostgresLedger(db);
    ({ policy, reception } = createStandaloneTextComposition(db, host));
  } else {
    ledger = new MemoryLedger();
    policy = new MemoryPolicyStore();
    reception = createEmbeddedTextComposition(ledger, policy, host);
  }
  if (bookingEnabled) value(await policy.changeBookingEnabled(scope, "0", true));
  const playback = new FakePlayback();
  const admission = new CallAdmissionService(ledger, async () => {
    const result = await policy.read(scope);
    return result.ok ? ok(result.value) : err({ kind: "routeUnavailable" as const });
  }, () => now);
  const callId = value(await admission.begin({ key: { accountRef: `account-${id}`, providerCallRef: `call-${id}` }, dialedNumber: "+6125550100", receivedAt: now })).receipt.callId;
  const sessionId = `session-${id}`;
  const session = new VoiceSession(callId, sessionId, scope, ledger, reception, playback, async turn =>
    ok(turn.text.startsWith("Book")
      ? { kind: "book" as const, verificationRef: patient.verificationRef, offerRef: offer.offerRef }
      : { kind: "affirm" as const }));
  value(await session.attach(at(1)));
  return { scope, patient, offer, host, ledger, policy, reception, playback, session, sessionId, callId };
}

async function bookTurn(app: Awaited<ReturnType<typeof fixture>>, text = "Book physio") {
  const generation = value(await app.session.speechStarted(at(2)));
  value(app.session.acceptTranscript({ kind: "partial", sessionId: app.sessionId, generation, utteranceId: "utterance-1", text: "Boo" }));
  value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "utterance-1", text, quality: "clear" }));
  return value(await app.session.finishTurn(at(3)));
}

for (const kind of kinds) {
  test(`${kind}: final turn and playback completion gate one booking`, async () => {
    const app = await fixture(kind, `${kind}-confirmed`, true);
    const generation = value(await app.session.speechStarted(at(2)));
    const sessionId = `session-${kind}-confirmed`;
    value(app.session.acceptTranscript({ kind: "partial", sessionId, generation, utteranceId: "first", text: "Book" }));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId, generation, utteranceId: "first", text: "Book physio", quality: "clear" }));
    assert.equal(Object.keys(value(await new CallRuntime(app.ledger, app.scope).read(app.callId)).actions).length, 0);
    const planned = value(await app.session.finishTurn(at(3)));
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    assert.equal(action.status, "awaitingConfirmation");
    const queued = value(await app.session.dispatchPending(at(4)));
    assert.equal(queued.kind, "queued");
    assert.equal(app.host.bookings(app.scope).length, 0);
    assert.equal(value(await app.session.drainEffects(at(5))).actions[action.key]?.status, "awaitingConfirmation");
    failure(await app.session.acceptPlaybackResult("wrong-playback", "played", at(5)), "playbackUnknown");
    value(await app.session.acceptPlaybackResult(queued.playbackId!, "played", at(5)));
    assert.equal(value(await new CallRuntime(app.ledger, app.scope).read(app.callId)).presentations[action.presentationId]?.status, "played");

    const nextGeneration = value(await app.session.speechStarted(at(6)));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId, generation: nextGeneration, utteranceId: "affirm", text: "Yes book it", quality: "clear" }));
    const ready = value(await app.session.finishTurn(at(7)));
    assert.equal(ready.actions[action.key]?.status, "ready");
    assert.equal(app.host.bookings(app.scope).length, 0);
    const committed = value(await app.session.drainEffects(at(8)));
    assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(app.host.bookings(app.scope).length, 1);
  });

  test(`${kind}: disabled booking setting avoids host reads and writes`, async () => {
    const app = await fixture(kind, `${kind}-disabled`, false);
    const state = await bookTurn(app);
    assert.equal(state.policy.bookingEnabled, false);
    assert.equal(state.callerMessages.at(-1), "I can't complete that request here.");
    assert.equal(Object.keys(state.actions).length, 0);
    assert.equal(app.host.bookingEvidenceReads(), 0);
    assert.equal(value(await app.session.dispatchPending(at(4))).kind, "none");
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: interruption and late playback ack cannot confirm booking`, async () => {
    const app = await fixture(kind, `${kind}-interrupt`, true);
    const planned = await bookTurn(app);
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    const queued = value(await app.session.dispatchPending(at(4)));
    const generation = value(await app.session.speechStarted(at(5)));
    assert.equal(app.playback.cleared.length, 1);
    assert.equal(value(await new CallRuntime(app.ledger, app.scope).read(app.callId)).presentations[action.presentationId]?.status, "interrupted");
    failure(await app.session.acceptPlaybackResult(queued.playbackId!, "played", at(6)), "playbackUnknown");
    const sessionId = `session-${kind}-interrupt`;
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId, generation, utteranceId: "yes", text: "Yes book it", quality: "clear" }));
    failure(await app.session.finishTurn(at(7)), "confirmationMissing");
    assert.equal(app.host.bookings(app.scope).length, 0);
    assert.equal(Object.keys(value(await app.session.drainEffects(at(8))).effects).filter(key => key.endsWith(":write")).length, 0);
  });

  test(`${kind}: disconnect leaves queued playback unproven and no booking`, async () => {
    const app = await fixture(kind, `${kind}-disconnect`, true);
    const planned = await bookTurn(app);
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    const queued = value(await app.session.dispatchPending(at(4)));
    const ended = value(await app.session.end(at(5)));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[action.presentationId]?.status, "unproven");
    failure(await app.session.acceptPlaybackResult(queued.playbackId!, "played", at(6)), "playbackUnknown");
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: failed clear or uncertain enqueue never produces played evidence`, async () => {
    const uncertain = await fixture(kind, `${kind}-uncertain-enqueue`, true);
    const planned = await bookTurn(uncertain);
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    uncertain.playback.sendResult = "uncertain";
    assert.equal(value(await uncertain.session.dispatchPending(at(4))).kind, "unproven");
    assert.equal(value(await new CallRuntime(uncertain.ledger, uncertain.scope).read(uncertain.callId)).presentations[action.presentationId]?.status, "unproven");
    assert.equal(uncertain.host.bookings(uncertain.scope).length, 0);

    const blocked = await fixture(kind, `${kind}-clear-failure`, true);
    const blockedPlan = await bookTurn(blocked);
    const blockedAction = Object.values(blockedPlan.actions)[0];
    assert.ok(blockedAction);
    const queued = value(await blocked.session.dispatchPending(at(4)));
    blocked.playback.clearResult = false;
    failure(await blocked.session.speechStarted(at(5)), "transportUnavailable");
    const ended = value(await new CallRuntime(blocked.ledger, blocked.scope).read(blocked.callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[blockedAction.presentationId]?.status, "unproven");
    failure(await blocked.session.acceptPlaybackResult(queued.playbackId!, "played", at(6)), "playbackUnknown");
    assert.equal(blocked.host.bookings(blocked.scope).length, 0);
  });

  test(`${kind}: interruption during enqueue reports the durable unproven outcome`, async () => {
    const app = await fixture(kind, `${kind}-enqueue-race`, true);
    const planned = await bookTurn(app);
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    let releaseSend!: (result: "queued" | "notSent" | "uncertain") => void;
    app.playback.sendPromise = new Promise(resolve => { releaseSend = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    app.playback.enqueueStarted = signalStarted;
    const dispatch = app.session.dispatchPending(at(4));
    await started;
    app.playback.clearResult = false;
    failure(await app.session.speechStarted(at(5)), "transportUnavailable");
    releaseSend("queued");
    assert.equal(value(await dispatch).kind, "unproven");
    const ended = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[action.presentationId]?.status, "unproven");
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: newer speech fences a prior turn waiting on host evidence`, async () => {
    const app = await fixture(kind, `${kind}-stale-host-read`, true);
    let signalRead!: () => void;
    const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const original = app.host.resolveBooking.bind(app.host);
    app.host.resolveBooking = async (...args) => {
      signalRead();
      await readGate;
      return original(...args);
    };
    const first = value(await app.session.speechStarted(at(2)));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation: first, utteranceId: "first", text: "Book physio", quality: "clear" }));
    const staleFinish = app.session.finishTurn(at(3));
    await readStarted;
    const second = value(await app.session.speechStarted(at(4)));
    releaseRead();
    failure(await staleFinish, "staleTurn");
    const afterStale = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(Object.keys(afterStale.actions).length, 0);
    assert.equal(afterStale.processedTurnIds.length, 0);
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation: second, utteranceId: "second", text: "Book physio", quality: "clear" }));
    const fresh = value(await app.session.finishTurn(at(5)));
    assert.equal(Object.values(fresh.actions)[0]?.status, "awaitingConfirmation");
  });

  test(`${kind}: speech onset supersedes unsent details before any playback`, async () => {
    const app = await fixture(kind, `${kind}-onset-pending`, true);
    const planned = await bookTurn(app);
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    value(await app.session.speechStarted(at(4)));
    const state = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(state.presentations[action.presentationId]?.status, "superseded");
    assert.equal(state.actions[action.key]?.status, "canceled");
    assert.equal(state.pendingPresentationId, undefined);
    failure(await app.session.dispatchPending(at(5)), "deliveryBlocked");
    assert.equal(app.playback.queued.length, 0);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });
}
