import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { CallPolicy, LocationScope, Result } from "../../src/core/model.ts";
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
import { CallLivenessMonitor } from "../../src/voice/call-liveness-monitor.ts";
import { PresentationDispatcher } from "../../src/voice/presentation-dispatcher.ts";
import type { TimerPort } from "../../src/voice/timer.ts";
import { VoiceLeaseLoop } from "../../src/voice/voice-lease-loop.ts";
import { VoiceWorkLoop } from "../../src/voice/voice-work-loop.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { PlaybackPort, TransferOutcome, TransferPort } from "../../src/voice/voice-session.ts";

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

class FakeTransfer implements TransferPort {
  readonly requested: Array<{ id: string; destinationRef: string }> = [];
  outcome: TransferOutcome = { kind: "failed" };
  pending?: Promise<TransferOutcome>;
  onRequest?: () => void;

  async request(id: string, destinationRef: string): Promise<TransferOutcome> {
    this.requested.push({ id, destinationRef });
    this.onRequest?.();
    return this.pending ?? this.outcome;
  }
}

class PresentationStartHookLedger implements LedgerStore {
  private readonly inner: LedgerStore;
  private readonly onStart: () => void;
  private readonly onRenew: (() => void) | undefined;
  constructor(inner: LedgerStore, onStart: () => void, onRenew?: () => void) {
    this.inner = inner;
    this.onStart = onStart;
    this.onRenew = onRenew;
  }
  start(...args: Parameters<LedgerStore["start"]>) { return this.inner.start(...args); }
  findAdmission(...args: Parameters<LedgerStore["findAdmission"]>) { return this.inner.findAdmission(...args); }
  findExpiredAdmissions(...args: Parameters<LedgerStore["findExpiredAdmissions"]>) { return this.inner.findExpiredAdmissions(...args); }
  findExpiredSessions(...args: Parameters<LedgerStore["findExpiredSessions"]>) { return this.inner.findExpiredSessions(...args); }
  findPendingPresentations(...args: Parameters<LedgerStore["findPendingPresentations"]>) { return this.inner.findPendingPresentations(...args); }
  admit(...args: Parameters<LedgerStore["admit"]>) { return this.inner.admit(...args); }
  read(...args: Parameters<LedgerStore["read"]>) { return this.inner.read(...args); }
  async apply(...args: Parameters<LedgerStore["apply"]>) {
    const result = await this.inner.apply(...args);
    if (result.ok && args[3].kind === "presentationStarted") this.onStart();
    if (result.ok && args[3].kind === "sessionRenewed") this.onRenew?.();
    return result;
  }
}

async function fixture(kind: "memory" | "postgres", id: string, bookingEnabled: boolean, transferMode: "execute" | "requestOnly" | "unavailable" = "requestOnly", transferDestinationRef?: string, clock?: { now: () => number; onPresentationStarted?: () => void; onSessionRenewed?: () => void }) {
  const scope: LocationScope = { tenantId: `voice-tenant-${id}`, clinicId: `voice-clinic-${id}`, locationId: `voice-location-${id}` };
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `proof-${id}`, expiresAt: at(86_400) };
  const offer = { scope, offerRef: `offer-${id}`, serviceRef: "physio", startsAt: at(90_000), expiresAt: at(86_400) };
  const host = new ReferenceClinicHost([patient], [offer]);
  let ledger: LedgerStore;
  let policy: PolicyStore;
  let reception: TextReception;
  if (kind === "postgres") {
    assert.ok(db);
    ledger = new PostgresLedger(db, suggestedAt => suggestedAt);
    ({ policy, reception } = createStandaloneTextComposition(db, host, "execute", ledger));
  } else {
    ledger = new MemoryLedger();
    policy = new MemoryPolicyStore();
    reception = createEmbeddedTextComposition(ledger, policy, host);
  }
  if (bookingEnabled) value(await policy.changeBookingEnabled(scope, "0", true));
  const playback = new FakePlayback();
  const transfer = new FakeTransfer();
  const admission = new CallAdmissionService(ledger, async () => {
    const result = await policy.read(scope);
    if (!result.ok) return err({ kind: "routeUnavailable" as const });
    const snapshot: CallPolicy = {
      ...result.value,
      capabilities: { ...result.value.capabilities, transfer: transferMode },
      ...(transferMode === "execute" ? { transferDestinationRef: transferDestinationRef ?? `destination-${id}` } : {}),
    };
    return ok(snapshot);
  }, () => now);
  const callId = value(await admission.begin({ key: { accountRef: `account-${id}`, providerCallRef: `call-${id}` }, dialedNumber: "+6125550100", receivedAt: now })).receipt.callId;
  const sessionId = `session-${id}`;
  const sessionLedger = clock?.onPresentationStarted || clock?.onSessionRenewed
    ? new PresentationStartHookLedger(ledger, clock.onPresentationStarted ?? (() => {}), clock.onSessionRenewed) : ledger;
  const session = new VoiceSession(callId, sessionId, scope, sessionLedger, reception, playback, async turn =>
    ok(turn.text.startsWith("Transfer")
      ? { kind: "transfer" as const, reason: "callerRequested" as const }
      : turn.text.startsWith("Book")
      ? { kind: "book" as const, verificationRef: patient.verificationRef, offerRef: offer.offerRef }
      : { kind: "affirm" as const }), transfer, clock?.now);
  value(await session.attach(at(1)));
  return { scope, patient, offer, host, ledger, policy, reception, playback, transfer, session, sessionId, callId };
}

async function bookTurn(app: Awaited<ReturnType<typeof fixture>>, text = "Book physio") {
  const generation = value(await app.session.speechStarted(at(2)));
  value(app.session.acceptTranscript({ kind: "partial", sessionId: app.sessionId, generation, utteranceId: "utterance-1", text: "Boo" }));
  value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "utterance-1", text, quality: "clear" }));
  return value(await app.session.finishTurn(at(3)));
}

async function transferTurn(app: Awaited<ReturnType<typeof fixture>>, quality: "clear" | "needsClarification" = "clear") {
  const generation = value(await app.session.speechStarted(at(2)));
  value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "transfer-request", text: "Transfer to staff", quality }));
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

  test(`${kind}: failed transfer creates staff work and a truthful spoken notice`, async () => {
    const app = await fixture(kind, `${kind}-transfer-failed`, false, "execute");
    const planned = await transferTurn(app);
    const transferId = planned.pendingPresentationId;
    assert.ok(transferId);
    assert.equal(planned.presentations[transferId]?.kind, "transfer");
    assert.equal(value(await app.session.dispatchPending(at(4))).kind, "transferFailed");
    const failed = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(failed.presentations[transferId]?.status, "failed");
    assert.equal(Object.values(failed.staffItems)[0]?.reason, "transferFailed");
    assert.equal(failed.presentations[failed.pendingPresentationId!]?.kind, "notice");
    assert.match(failed.callerMessages.at(-1)!, /couldn't connect/);
    assert.equal(value(await app.session.drainEffects(at(5))).staffItems[Object.keys(failed.staffItems)[0]!]?.status, "open");
    const notice = value(await app.session.dispatchPending(at(6)));
    assert.equal(notice.kind, "queued");
    value(await app.session.acceptPlaybackResult(notice.playbackId!, "played", at(7)));
    assert.equal(app.transfer.requested.length, 1);
    assert.equal(app.playback.queued.length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: connected and unproven transfers have distinct terminal evidence`, async () => {
    const connected = await fixture(kind, `${kind}-transfer-connected`, false, "execute");
    const plan = await transferTurn(connected);
    connected.transfer.outcome = { kind: "connected", providerConnectionRef: "provider-connected-1" };
    assert.equal(value(await connected.session.dispatchPending(at(4))).kind, "transferConnected");
    const done = value(await new CallRuntime(connected.ledger, connected.scope).read(connected.callId));
    assert.equal(done.lifecycle, "ended");
    const completedTransfer = done.presentations[plan.pendingPresentationId!];
    assert.ok(completedTransfer?.kind === "transfer");
    assert.equal(completedTransfer.status, "connected");
    assert.equal(completedTransfer.providerConnectionRef, "provider-connected-1");
    assert.equal(Object.keys(done.staffItems).length, 0);

    const unproven = await fixture(kind, `${kind}-transfer-unproven`, false, "execute");
    const uncertainPlan = await transferTurn(unproven);
    unproven.transfer.outcome = { kind: "connected", providerConnectionRef: "" };
    assert.equal(value(await unproven.session.dispatchPending(at(4))).kind, "transferUnproven");
    const unresolved = value(await new CallRuntime(unproven.ledger, unproven.scope).read(unproven.callId));
    assert.equal(unresolved.lifecycle, "ended");
    assert.equal(unresolved.presentations[uncertainPlan.pendingPresentationId!]?.status, "unproven");
    assert.equal(Object.values(unresolved.staffItems)[0]?.reason, "systemFailure");
    assert.equal(unresolved.pendingPresentationId, undefined);
  });

  test(`${kind}: request-only or unclear transfer never reaches provider`, async () => {
    const requestOnly = await fixture(kind, `${kind}-transfer-request-only`, false);
    const routed = await transferTurn(requestOnly);
    assert.equal(routed.pendingPresentationId, undefined);
    assert.equal(Object.values(routed.staffItems)[0]?.reason, "callerRequested");
    assert.equal(requestOnly.transfer.requested.length, 0);
    assert.equal(value(await requestOnly.session.dispatchPending(at(4))).kind, "none");

    const unclear = await fixture(kind, `${kind}-transfer-unclear`, false, "execute");
    const state = await transferTurn(unclear, "needsClarification");
    assert.equal(state.pendingPresentationId, undefined);
    assert.equal(Object.values(state.staffItems)[0]?.reason, "verificationFailed");
    assert.equal(unclear.transfer.requested.length, 0);

    const unavailable = await fixture(kind, `${kind}-transfer-unavailable`, false, "unavailable");
    const unavailableState = await transferTurn(unavailable);
    assert.equal(unavailableState.pendingPresentationId, undefined);
    assert.equal(unavailable.transfer.requested.length, 0);
    assert.match(unavailableState.callerMessages.at(-1)!, /can't connect/);

    const missingDestination = await fixture(kind, `${kind}-transfer-no-destination`, false, "execute", " ");
    const missingState = await transferTurn(missingDestination);
    assert.equal(missingState.pendingPresentationId, undefined);
    assert.equal(missingDestination.transfer.requested.length, 0);
  });

  test(`${kind}: durable transfer send barrier forbids false connection or late cancel`, async () => {
    const unsent = await fixture(kind, `${kind}-transfer-unsent`, false, "execute");
    const unsentPlan = await transferTurn(unsent);
    const unsentId = unsentPlan.pendingPresentationId!;
    const unsentRuntime = new CallRuntime(unsent.ledger, unsent.scope);
    value(await unsentRuntime.startPresentation(unsent.callId, unsentId, unsent.sessionId, at(4)));
    const canceled = value(await unsentRuntime.resolvePresentation(unsent.callId, unsentId, "canceled", unsent.sessionId, at(4)));
    assert.equal(canceled.presentations[unsentId]?.status, "canceled");
    assert.equal(Object.keys(canceled.staffItems).length, 0);
    assert.equal(unsent.transfer.requested.length, 0);

    const app = await fixture(kind, `${kind}-transfer-barrier`, false, "execute");
    const planned = await transferTurn(app);
    const presentationId = planned.pendingPresentationId!;
    const runtime = new CallRuntime(app.ledger, app.scope);
    value(await runtime.startPresentation(app.callId, presentationId, app.sessionId, at(4)));
    failure(await runtime.resolvePresentation(app.callId, presentationId, "connected", app.sessionId, at(4), "provider-ref"), "invalidTransition");
    value(await runtime.markTransferPossiblySent(app.callId, presentationId, app.sessionId, at(4)));
    failure(await runtime.resolvePresentation(app.callId, presentationId, "canceled", app.sessionId, at(5)), "invalidTransition");
    const failed = value(await runtime.resolvePresentation(app.callId, presentationId, "failed", app.sessionId, at(5)));
    assert.equal(failed.presentations[presentationId]?.status, "failed");
    assert.equal(Object.values(failed.staffItems)[0]?.reason, "transferFailed");
    assert.equal(app.transfer.requested.length, 0);
  });

  test(`${kind}: disconnect while transfer is in flight cannot invent connection`, async () => {
    const app = await fixture(kind, `${kind}-transfer-disconnect`, false, "execute");
    const planned = await transferTurn(app);
    let release!: (result: TransferOutcome) => void;
    app.transfer.pending = new Promise(resolve => { release = resolve; });
    let signal!: () => void;
    const requested = new Promise<void>(resolve => { signal = resolve; });
    app.transfer.onRequest = signal;
    const dispatch = app.session.dispatchPending(at(4));
    await requested;
    value(await app.session.end(at(5)));
    release({ kind: "connected", providerConnectionRef: "late-provider-result" });
    assert.equal(value(await dispatch).kind, "transferUnproven");
    const ended = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[planned.pendingPresentationId!]?.status, "unproven");
    assert.equal(Object.values(ended.staffItems)[0]?.reason, "systemFailure");
  });

  test(`${kind}: a stalled presentation cannot send speech after the local lease gate closes`, async () => {
    let monotonicMs = 0;
    const app = await fixture(kind, `${kind}-stalled-speech`, true, "requestOnly", undefined,
      { now: () => monotonicMs, onPresentationStarted: () => { monotonicMs = 29_000; } });
    const planned = await bookTurn(app);
    failure(await app.session.dispatchPending(at(4)), "leaseLost");
    assert.equal(app.playback.queued.length, 0);
    const ended = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[planned.pendingPresentationId!]?.status, "unproven");
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: a stalled transfer cannot reach the provider after the local lease gate closes`, async () => {
    let monotonicMs = 0;
    const app = await fixture(kind, `${kind}-stalled-transfer`, false, "execute", undefined,
      { now: () => monotonicMs, onPresentationStarted: () => { monotonicMs = 29_000; } });
    const planned = await transferTurn(app);
    failure(await app.session.dispatchPending(at(4)), "leaseLost");
    assert.equal(app.transfer.requested.length, 0);
    const ended = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.presentations[planned.pendingPresentationId!]?.status, "unproven");
    assert.equal(Object.values(ended.staffItems)[0]?.reason, "systemFailure");
  });

  test(`${kind}: a timely renewal extends the local gate, but an expired gate cannot renew`, async () => {
    let monotonicMs = 0;
    const app = await fixture(kind, `${kind}-lease-renewal`, true, "requestOnly", undefined, { now: () => monotonicMs });
    await bookTurn(app);
    monotonicMs = 15_000;
    const renewed = value(await app.session.renew(at(16)));
    assert.equal(renewed.sessionLease?.version, 2);
    monotonicMs = 29_000;
    const queued = value(await app.session.dispatchPending(at(30)));
    assert.equal(queued.kind, "queued");
    assert.equal(app.playback.queued.length, 1);
    monotonicMs = 43_000;
    failure(await app.session.renew(at(44)), "leaseLost");
    failure(await app.session.acceptPlaybackResult(queued.playbackId!, "played", at(44)), "leaseLost");
    const state = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(state.presentations[Object.keys(state.presentations)[0]!]?.status, "started");
  });

  test(`${kind}: a renewal response after the old local gate closes cannot reopen output`, async () => {
    let monotonicMs = 0;
    const app = await fixture(kind, `${kind}-renewal-stall`, true, "requestOnly", undefined,
      { now: () => monotonicMs, onSessionRenewed: () => { monotonicMs = 29_000; } });
    await bookTurn(app);
    monotonicMs = 15_000;
    failure(await app.session.renew(at(16)), "leaseLost");
    failure(await app.session.dispatchPending(at(30)), "leaseLost");
    assert.equal(app.playback.queued.length, 0);
  });

  test(`${kind}: a lost delivery wake-up is recovered once from durable pending state`, async () => {
    const app = await fixture(kind, `${kind}-lost-wakeup`, true);
    const planned = await bookTurn(app);
    const textOnlyCallId = `text-only-${kind}-lost-wakeup`;
    value(await app.reception.startCall(textOnlyCallId, app.scope));
    value(await app.reception.proposeBooking(app.scope,
      { callId: textOnlyCallId, turnId: "text-only-request", text: "Book physio", quality: "clear", at: at(3) },
      app.patient.verificationRef, app.offer.offerRef, at(3)));
    assert.equal(app.playback.queued.length, 0);
    const dispatcher = new PresentationDispatcher(app.ledger, ref => ref.callId === app.callId && ref.sessionId === app.sessionId ? app.session : undefined, app.scope);
    assert.deepEqual(value(await dispatcher.recover(at(4))), { scanned: 1, dispatched: 1, deferred: 0 });
    const started = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(started.presentations[planned.pendingPresentationId!]?.status, "started");
    assert.equal(app.playback.queued.length, 1);
    assert.deepEqual(value(await dispatcher.recover(at(5))), { scanned: 0, dispatched: 0, deferred: 0 });
    assert.equal(app.playback.queued.length, 1);
    value(await app.session.acceptPlaybackResult(app.playback.queued[0]!, "played", at(6)));
    const generation = value(await app.session.speechStarted(at(7)));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "affirm-after-recovery", text: "Yes", quality: "clear" }));
    value(await app.session.finishTurn(at(8)));
    value(await app.session.drainEffects(at(9)));
    assert.equal(app.host.bookings(app.scope).length, 1);
  });

  test(`${kind}: a missing session defers pending delivery until lease expiry`, async () => {
    const app = await fixture(kind, `${kind}-missing-dispatch-session`, true);
    const planned = await bookTurn(app);
    const dispatcher = new PresentationDispatcher(app.ledger, () => undefined, app.scope);
    assert.deepEqual(value(await dispatcher.recover(at(4))), { scanned: 1, dispatched: 0, deferred: 1 });
    assert.equal(app.playback.queued.length, 0);
    assert.equal(value(await new CallRuntime(app.ledger, app.scope).read(app.callId)).presentations[planned.pendingPresentationId!]?.status, "pending");
    assert.equal(value(await new CallLivenessMonitor(app.ledger, app.scope).expireDue(at(31))), 1);
    assert.deepEqual(value(await dispatcher.recover(at(32))), { scanned: 0, dispatched: 0, deferred: 0 });
    const ended = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(ended.presentations[planned.pendingPresentationId!]?.status, "superseded");
    assert.equal(app.playback.queued.length, 0);
  });

  test(`${kind}: a lost wake-up recovers a transfer without replay`, async () => {
    const app = await fixture(kind, `${kind}-lost-transfer-wakeup`, false, "execute");
    const planned = await transferTurn(app);
    app.transfer.outcome = { kind: "connected", providerConnectionRef: "recovered-connection" };
    const dispatcher = new PresentationDispatcher(app.ledger, () => app.session, app.scope);
    assert.deepEqual(value(await dispatcher.recover(at(4))), { scanned: 1, dispatched: 1, deferred: 0 });
    assert.equal(app.transfer.requested.length, 1);
    const state = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(state.presentations[planned.pendingPresentationId!]?.status, "connected");
    assert.equal(state.lifecycle, "ended");
    assert.deepEqual(value(await dispatcher.recover(at(5))), { scanned: 0, dispatched: 0, deferred: 0 });
    assert.equal(app.transfer.requested.length, 1);
  });

  test(`${kind}: concurrent wake and recovery cannot send the same presentation twice`, async () => {
    const app = await fixture(kind, `${kind}-dispatch-race`, true);
    await bookTurn(app);
    const dispatcher = new PresentationDispatcher(app.ledger, () => app.session, app.scope);
    const [wake, recovery] = await Promise.all([
      dispatcher.wake(app.callId, app.scope, at(4)), dispatcher.recover(at(4)),
    ]);
    value(wake);
    value(recovery);
    assert.equal(app.playback.queued.length, 1);
    const state = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(Object.values(state.presentations).filter(presentation => presentation.status === "started").length, 1);
  });

  test(`${kind}: dispatcher rejects a session registry entry for another call`, async () => {
    const intended = await fixture(kind, `${kind}-registry-intended`, true);
    const other = await fixture(kind, `${kind}-registry-other`, true);
    await bookTurn(intended);
    await bookTurn(other);
    const dispatcher = new PresentationDispatcher(intended.ledger, () => other.session, intended.scope);
    failure(await dispatcher.wake(intended.callId, intended.scope, at(4)), "sessionUnknown");
    assert.equal(intended.playback.queued.length, 0);
    assert.equal(other.playback.queued.length, 0);
    assert.equal(value(await new CallRuntime(intended.ledger, intended.scope).read(intended.callId)).pendingPresentationId !== undefined, true);
    const unavailable = new PresentationDispatcher(intended.ledger, () => { throw new Error("registry offline"); }, intended.scope);
    failure(await unavailable.recover(at(4)), "sessionRegistryUnavailable");
    assert.equal(intended.playback.queued.length, 0);
  });

  test(`${kind}: worker recovery delivers a missed presentation and preserves booking confirmation`, async () => {
    const app = await fixture(kind, `${kind}-worker-recovery`, true);
    const planned = await bookTurn(app);
    const worker = new VoiceWorkLoop(
      new CallLivenessMonitor(app.ledger, app.scope),
      new PresentationDispatcher(app.ledger, () => app.session, app.scope),
      () => {}, { clock: () => at(4) },
    );
    const report = value(await worker.runOnce());
    assert.equal(report.expired, 0);
    assert.deepEqual(report.recovery, { scanned: 1, dispatched: 1, deferred: 0 });
    assert.equal(app.playback.queued.length, 1);
    value(await app.session.acceptPlaybackResult(app.playback.queued[0]!, "played", at(5)));
    const generation = value(await app.session.speechStarted(at(6)));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "worker-affirm", text: "Yes", quality: "clear" }));
    value(await app.session.finishTurn(at(7)));
    value(await app.session.drainEffects(at(8)));
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(value(await new CallRuntime(app.ledger, app.scope).read(app.callId)).presentations[planned.pendingPresentationId!]?.status, "played");
  });

  test(`${kind}: worker expires a stale lease before attempting pending delivery`, async () => {
    const app = await fixture(kind, `${kind}-worker-expiry`, true);
    const planned = await bookTurn(app);
    const worker = new VoiceWorkLoop(
      new CallLivenessMonitor(app.ledger, app.scope),
      new PresentationDispatcher(app.ledger, () => app.session, app.scope),
      () => {}, { clock: () => at(31) },
    );
    const report = value(await worker.runOnce());
    assert.equal(report.expired, 1);
    assert.equal(report.recovery.dispatched, 0);
    assert.equal(app.playback.queued.length, 0);
    const state = value(await new CallRuntime(app.ledger, app.scope).read(app.callId));
    assert.equal(state.presentations[planned.pendingPresentationId!]?.status, "superseded");
  });

  test(`${kind}: a commit notification wakes the exact pending call`, async () => {
    const app = await fixture(kind, `${kind}-worker-notify`, true);
    await bookTurn(app);
    const worker = new VoiceWorkLoop(
      new CallLivenessMonitor(app.ledger, app.scope),
      new PresentationDispatcher(app.ledger, () => app.session, app.scope),
      () => {}, { clock: () => at(4) },
    );
    assert.equal(value(await worker.notifyCommitted(app.callId, app.scope)).kind, "dispatched");
    assert.equal(app.playback.queued.length, 1);
    assert.equal(value(await worker.notifyCommitted(app.callId, app.scope)).kind, "none");
    assert.equal(app.playback.queued.length, 1);
  });

  test(`${kind}: scheduled renewals keep an attached call able to deliver after the original lease`, async () => {
    let monotonicMs = 0;
    const app = await fixture(kind, `${kind}-scheduled-renewal`, true, "requestOnly", undefined, { now: () => monotonicMs });
    await bookTurn(app);
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const timer: TimerPort = {
      schedule(callback) { const handle = ++nextHandle; callbacks.set(handle, callback); return handle; },
      cancel(handle) { callbacks.delete(handle as number); },
    };
    let wallTime = at(11);
    let completed!: () => void;
    const renewals: number[] = [];
    const loop = new VoiceLeaseLoop(app.session, result => {
      renewals.push(value(result).sessionLease!.version);
      completed();
    }, { timer, clock: () => wallTime });
    loop.start();
    loop.start();
    assert.equal(callbacks.size, 1);
    for (const step of [10, 20]) {
      monotonicMs = step * 1_000;
      wallTime = at(step + 1);
      const finished = new Promise<void>(resolve => { completed = resolve; });
      const [handle, callback] = callbacks.entries().next().value!;
      callbacks.delete(handle);
      callback();
      await finished;
    }
    assert.deepEqual(renewals, [2, 3]);
    monotonicMs = 30_000;
    assert.equal(value(await app.session.dispatchPending(at(31))).kind, "queued");
    assert.equal(app.playback.queued.length, 1);
    await loop.stop();
    assert.equal(callbacks.size, 0);
  });
}
