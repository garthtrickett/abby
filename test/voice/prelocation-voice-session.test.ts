import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { PrelocationVoiceSession } from "../../src/voice/prelocation-voice-session.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import type { PlaybackPort } from "../../src/voice/voice-session.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres") {
  const id = `${kind}-prelocation-${++sequence}`;
  const main = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const north = { ...main, locationId: "north" };
  const accountRef = `account-${id}`;
  const dialedNumber = "+6125550101";
  const host = new ReferenceNumberRoutingHost([
    { accountRef, dialedNumber, ...main, spokenName: "Main Street", routeVersion: "v1" },
    { accountRef, dialedNumber, ...north, spokenName: "Northside", routeVersion: "v1" },
  ]);
  let policyReads = 0;
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested) : new MemoryLedger();
  const policy = kind === "postgres"
    ? new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", async () => ok(true))
    : new MemoryPolicyStore("execute", () => now, async () => ok(true));
  const router = new ClinicPolicyRouter(host, { read(scope) { policyReads += 1; return policy.read(scope); } });
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const event = { key: { accountRef, providerCallRef: id }, dialedNumber, receivedAt: now };
  const queued: Array<{ id: string; text: string }> = [];
  const statusAtEnqueue: Array<string | undefined> = [];
  const cleared: string[] = [];
  let send: "queued" | "notSent" | "uncertain" = "queued";
  let clear = true;
  const playback: PlaybackPort = {
    async enqueue(id, text) {
      statusAtEnqueue.push(value(await ledger.findPendingLocation(callIdFor(event.key)))?.prompt?.status);
      queued.push({ id, text });
      return send;
    },
    async clear(id) { cleared.push(id); return clear; },
  };
  const session = () => new PrelocationVoiceSession(event, "session", ledger, intake, playback);
  return { main, north, ledger, policy, intake, event, queued, statusAtEnqueue, cleared, session,
    policyReads: () => policyReads, setSend(result: typeof send) { send = result; }, setClear(result: boolean) { clear = result; } };
}

for (const kind of kinds) {
  test(`${kind}: prompt evidence and clear transcript bind one location, then hand off the session`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    const prompt = value(await session.dispatchPrompt(now));
    assert.equal(prompt.kind, "queued");
    assert.deepEqual(app.queued, [{ id: prompt.playbackId,
      text: "Which location would you like? Please say Main Street or Northside." }]);
    assert.deepEqual(app.statusAtEnqueue, ["started"]);
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "queued");
    const restarted = app.session();
    value(await restarted.attach());
    assert.equal(value(await restarted.dispatchPrompt(now)).playbackId, prompt.playbackId);
    assert.equal(app.queued.length, 1);
    value(await session.acceptPlaybackResult(prompt.playbackId, "played", now));
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "played");
    const generation = value(await session.speechStarted(now));
    value(session.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation, utteranceId: "choice",
      text: "Northside", quality: "clear" }));
    value(await app.policy.changeAutomationEnabled(app.north, "0", true, "admin"));
    const bound = value(await session.finishTurn(now));
    assert.deepEqual(bound.receipt.scope, app.north);
    assert.equal(value(await app.ledger.findPendingLocation(bound.receipt.callId))?.choiceEvidence?.sessionId, "session");
    value(await new CallRuntime(app.ledger, app.north).activate(bound.receipt.callId, "session", now));
    assert.equal((await new CallRuntime(app.ledger, app.main).read(bound.receipt.callId)).ok, false);
  });

  test(`${kind}: definite send failure permits one new attempt; an uncertain send never replays`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    app.setSend("notSent");
    const failed = value(await session.dispatchPrompt(now));
    assert.equal(failed.kind, "failed");
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "failed");
    app.setSend("uncertain");
    const uncertain = value(await session.dispatchPrompt(now));
    assert.equal(uncertain.kind, "unproven");
    assert.notEqual(uncertain.playbackId, failed.playbackId);
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "unproven");
    assert.equal(value(await session.dispatchPrompt(now)).playbackId, uncertain.playbackId);
    assert.equal(app.queued.length, 2);
  });

  test(`${kind}: concurrent prompt dispatch has one sender and renewed lease fences stale callbacks`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const first = app.session();
    const second = app.session();
    value(await first.attach());
    value(await second.attach());
    const [left, right] = await Promise.all([first.dispatchPrompt(now), second.dispatchPrompt(now)]);
    const leftPrompt = value(left);
    const rightPrompt = value(right);
    assert.equal(leftPrompt.playbackId, rightPrompt.playbackId);
    assert.equal(app.queued.length, 1);
    const sender = leftPrompt.kind === "queued" ? first : second;
    const renewed = value(await sender.renew());
    assert.equal(renewed.sessionLease?.version, 2);
    const stale = await app.ledger.resolvePendingLocationPrompt(callIdFor(app.event.key), leftPrompt.playbackId,
      "session", 1, "played", now);
    assert.ok(!stale.ok);
    assert.equal(stale.error.kind, "leaseLost");
    const played = await sender.acceptPlaybackResult(leftPrompt.playbackId, "played", now);
    assert.ok(played.ok);
  });

  test(`${kind}: interruption clears playback and late provider results cannot change its outcome`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    const prompt = value(await session.dispatchPrompt(now));
    const generation = value(await session.speechStarted(now));
    assert.deepEqual(app.cleared, [prompt.playbackId]);
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "interrupted");
    const late = await session.acceptPlaybackResult(prompt.playbackId, "played", now);
    assert.ok(!late.ok);
    assert.equal(late.error.kind, "playbackUnknown");
    value(session.acceptTranscript({ kind: "segmentFinal", sessionId: "session", generation, utteranceId: "unclear",
      text: "somewhere else", quality: "clear" }));
    const unclear = await session.finishTurn(now);
    assert.ok(!unclear.ok);
    assert.equal(unclear.error.kind, "locationChoiceUnclear");
    assert.equal(app.policyReads(), 0);
  });

  test(`${kind}: failed clear makes delivery unproven and blocks further caller turns`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    value(await session.dispatchPrompt(now));
    app.setClear(false);
    const started = await session.speechStarted(now);
    assert.ok(!started.ok);
    assert.equal(started.error.kind, "transportUnavailable");
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(app.event.key)))?.prompt?.status, "unproven");
    assert.equal(app.policyReads(), 0);
  });

  test(`${kind}: disconnect closes a pending choice and records interrupted prompt evidence`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    const prompt = value(await session.dispatchPrompt(now));
    const foreign = await app.ledger.closePendingLocationSession(callIdFor(app.event.key), "foreign-session", 1,
      "callerDisconnected", now);
    assert.ok(!foreign.ok);
    assert.equal(foreign.error.kind, "leaseLost");
    const closed = value(await session.end(now, "callerDisconnected"));
    assert.equal(closed.status, "expired");
    assert.equal(closed.closeEvidence?.reason, "callerDisconnected");
    assert.equal(closed.prompt?.status, "interrupted");
    assert.deepEqual(app.cleared, [prompt.playbackId]);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(app.event.key))), null);
    const late = await session.acceptPlaybackResult(prompt.playbackId, "played", now);
    assert.ok(!late.ok);
    assert.equal(late.error.kind, "playbackUnknown");
    const retry = await app.intake.begin(app.event);
    assert.ok(!retry.ok);
    assert.equal(retry.error.kind, "admissionExpired");
    assert.equal(app.policyReads(), 0);
    const replay = value(await app.ledger.closePendingLocationSession(callIdFor(app.event.key), "session", 1,
      "callerDisconnected", now));
    assert.deepEqual(replay, closed);
  });

  test(`${kind}: unproven clear and liveness expiry never count a prompt as played`, async () => {
    const app = fixture(kind);
    value(await app.intake.begin(app.event));
    const session = app.session();
    value(await session.attach());
    value(await session.dispatchPrompt(now));
    app.setClear(false);
    const closed = value(await session.end(now, "callerDisconnected"));
    assert.equal(closed.prompt?.status, "unproven");
    assert.equal(closed.status, "expired");

    const another = fixture(kind);
    value(await another.intake.begin(another.event));
    const attached = value(await another.intake.attachSession(another.event, "session"));
    value(await another.ledger.startPendingLocationPrompt(callIdFor(another.event.key), "prompt", "session",
      attached.sessionLease!.version, now));
    const expired = value(await another.ledger.expirePendingLocation(callIdFor(another.event.key),
      new Date(Date.parse(now) + 31_000).toISOString()));
    assert.equal(expired.kind, "expired");
    assert.equal(expired.pending.prompt?.status, "unproven");
    assert.equal(expired.pending.closeEvidence, undefined);
  });
}
