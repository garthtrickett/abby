import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import type { PolicyStore } from "../../src/core/host.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import type { TransferContext, TransferOutcome } from "../../src/voice/voice-session.ts";
import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";

const now = "2026-10-01T10:00:00.000Z";
const readiness = async () => ok(true as const);
function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}
type Stores = { ledger: LedgerStore & EffectCallLeaseStore; policy: PolicyStore; scope: LocationScope;
  ready: boolean; hostVersion: string };

function newCall(stores: Stores, outcome: TransferOutcome | "throw" = { kind: "connected", providerConnectionRef: "host-connection" },
                 intent: "transfer" | "urgent" = "transfer") {
  const { scope, ledger, policy } = stores;
  const event = { key: { accountRef: "buyer-provider", providerCallRef: `staffed-${randomUUID()}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session-${randomUUID()}`;
  const requests: { id: string; destinationRef: string; context: TransferContext }[] = [];
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  let utterance = 0;
  let mediaSequence = 0;
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy,
    host: new ReferenceClinicHost([], []), readiness, now: () => now,
    routing: new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
      dialedNumber: event.dialedNumber, routeVersion: "number-route-v1" }]),
    resolveIntent: async () => intent === "urgent"
      ? ok({ kind: "handoff", reason: "potentiallyUrgent" })
      : ok({ kind: "transfer", reason: "callerRequested" }),
    transfer: { async request(id, destinationRef, context) {
      const admitted = value(await ledger.read(callId, scope)).policy;
      assert.deepEqual(context, { scope, callId, sessionId, policyVersion: admitted.policyVersion,
        hostVersion: admitted.transferDestinationVersion });
      assert.equal(destinationRef, admitted.transferDestinationRef);
      assert.equal(requests.some(request => request.id === id), false, "a possibly sent transfer cannot be replayed");
      requests.push({ id, destinationRef, context: structuredClone(context) });
      if (outcome === "throw") throw new Error("synthetic unknown provider outcome");
      return outcome;
    } },
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `request-${++utterance}`,
        text: intent === "urgent" ? "I need urgent help" : "Please connect me to staff", quality: "clear" }]);
    } },
    synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, sequence) {
      chunks.set(playbackId, [...(chunks.get(playbackId) ?? []), sequence]);
      return "queued" as const;
    }, async finishQueue() { return "queued" as const; }, async clear() { return true; } },
    mediaOptions: { silenceMs: 100 },
  });
  async function play(delivery: { kind: string; playbackId?: string }) {
    assert.equal(delivery.kind, "queued");
    assert.ok(delivery.playbackId);
    const sequences = chunks.get(delivery.playbackId);
    assert.ok(sequences?.length);
    value(await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId,
      lastSequence: sequences.at(-1)!, status: "played" }, now));
  }
  async function begin() {
    const admitted = value(await call.begin(now));
    assert.ok(admitted.kind === "admitted");
    await play(admitted.delivery);
    return value(await ledger.read(callId, scope));
  }
  async function speak() {
    let completed: Awaited<ReturnType<typeof call.acceptMedia>> | undefined;
    for (let frame = 0; frame < 7; frame += 1) {
      const bytes = new Uint8Array(640);
      if (frame < 2) {
        const view = new DataView(bytes.buffer);
        for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true);
      }
      completed = await call.acceptMedia({ sessionId, sequence: mediaSequence,
        capturedAt: new Date(Date.parse(now) + mediaSequence * 20).toISOString(), bytes });
      mediaSequence += 1;
      value(completed);
    }
    assert.ok(completed?.ok);
    assert.equal(completed.value.kind, "turnCompleted");
    return completed.value;
  }
  return { call, callId, sessionId, requests, spoken, begin, play, speak,
    state: async () => value(await ledger.read(callId, scope)) };
}

test("E2E-256 SET-007 complete embedded transfer settings calls", { timeout: 120_000 }, async t => {
  const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
  const adminUrl = process.env.DATABASE_URL;
  const databaseName = `abby_staffed_voice_${randomUUID().replaceAll("-", "")}`;
  const admin = kinds.length === 2 && adminUrl ? connectPostgres(adminUrl) : undefined;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let created = false;
  try {
    if (kinds.length === 2) {
      assert.ok(admin && adminUrl);
      await sql.raw(`create database "${databaseName}"`).execute(admin);
      created = true;
      const target = new URL(adminUrl);
      target.pathname = `/${databaseName}`;
      db = connectPostgres(target.toString());
      await migrate(db);
    }
    async function stores(kind: "memory" | "postgres", hours: "open" | "closed" | "unknown" = "open") {
      const state: Stores = { scope: { tenantId: `staffed-${randomUUID()}`, clinicId: "clinic", locationId: "main" },
        ready: true, hostVersion: "host-route-v1", ledger: undefined!, policy: undefined! };
      const registry = staffedDestinationRegistry(async (scope, ref) => state.ready && ["host/desk-a", "host/desk-b"].includes(ref)
        ? ok({ scope, destinationRef: ref, hostVersion: state.hostVersion, mode: "execute", ready: true })
        : err({ kind: "readinessFailed", missing: ["staffDestination"] }));
      state.ledger = kind === "memory" ? new MemoryLedger(readiness) : new PostgresLedger(db!, ref => ref, readiness, "unsafeReference");
      state.policy = kind === "memory" ? new MemoryPolicyStore("execute", () => now, readiness, undefined, registry)
        : new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", readiness, true, "unsafeReference", false, undefined, registry);
      value(await state.policy.changeAutomationEnabled(state.scope, "0", true, "clinic-admin"));
      if (hours !== "unknown") value(await state.policy.changeStaffSchedule(state.scope, "0", {
        scope: state.scope, version: "approved-hours-v1", ownerRef: "clinic-admin", approved: true,
        effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-10-02T00:00:00.000Z",
        timeZone: "UTC", weekly: [{ weekday: 4, startMinute: 9 * 60, endMinute: 11 * 60 }],
        closedDates: hours === "closed" ? ["2026-10-01"] : [],
      }, "clinic-admin"));
      return state;
    }
    for (const kind of kinds) {
      await t.test(`${kind}: unset, set, changed and cleared routes pin the admitted host context`, async () => {
        const store = await stores(kind);
        const off = newCall(store);
        assert.notEqual((await off.begin()).policy.capabilities.transfer, "execute");
        const offTurn = await off.speak();
        await off.play(offTurn.delivery);
        assert.equal(off.requests.length, 0);
        value(await off.call.disconnect(now));
        value(await store.policy.changeStaffedDestination(store.scope, "1", "host/desk-a", "clinic-admin"));
        const oldA = newCall(store);
        const admittedA = await oldA.begin();
        assert.equal(admittedA.policy.policyVersion, "2");
        assert.equal(admittedA.policy.transferDestinationVersion, "host-route-v1");
        value(await store.policy.changeStaffedDestination(store.scope, "2", "host/desk-b", "clinic-admin"));
        store.hostVersion = "host-route-v2";
        const oldB = newCall(store);
        assert.equal((await oldB.begin()).policy.transferDestinationVersion, "host-route-v2");
        value(await store.policy.changeStaffedDestination(store.scope, "3", null, "clinic-admin"));
        assert.equal((await oldA.speak()).delivery.kind, "transferConnected");
        assert.deepEqual(oldA.requests.map(request => [request.destinationRef, request.context.hostVersion]), [["host/desk-a", "host-route-v1"]]);
        assert.equal((await oldA.state()).terminal?.reason, "transferConnected");
        assert.equal((await oldB.speak()).delivery.kind, "transferConnected");
        assert.deepEqual(oldB.requests.map(request => [request.destinationRef, request.context.hostVersion]), [["host/desk-b", "host-route-v2"]]);
        const next = newCall(store);
        const nextState = await next.begin();
        assert.equal(nextState.policy.transferDestinationRef, undefined);
        assert.notEqual(nextState.policy.capabilities.transfer, "execute");
        await next.play((await next.speak()).delivery);
        assert.equal(next.requests.length, 0);
        assert.equal(next.spoken.some(text => /connected you|staff have received/i.test(text)), false);
        value(await next.call.disconnect(now));
        assert.deepEqual(value(await store.policy.listStaffedDestinationChanges(store.scope)).entries.map(row => row.version), ["2", "3", "4"]);
      });
      await t.test(`${kind}: unavailable routes, closed or unknown hours and urgent requests never attempt a live transfer`, async () => {
        for (const blocker of ["revoked", "closed", "unknown", "urgent"] as const) {
          const store = await stores(kind, blocker === "closed" || blocker === "unknown" ? blocker : "open");
          const version = value(await store.policy.read(store.scope)).policyVersion;
          value(await store.policy.changeStaffedDestination(store.scope, version, "host/desk-a", "clinic-admin"));
          if (blocker === "revoked") store.ready = false;
          const app = newCall(store, undefined, blocker === "urgent" ? "urgent" : "transfer");
          await app.begin();
          await app.play((await app.speak()).delivery);
          assert.equal(app.requests.length, 0, blocker);
          assert.equal(Object.values((await app.state()).presentations).some(item => item.kind === "transfer"), false);
          if (blocker === "closed") assert.match(app.spoken.at(-1)!, /aren't available for a live transfer/);
          if (blocker === "unknown") assert.match(app.spoken.at(-1)!, /can't confirm whether staff are available/);
          if (blocker === "urgent") assert.match(app.spoken.at(-1)!, /can't give advice/);
          value(await app.call.disconnect(now));
        }
      });
      await t.test(`${kind}: failed and unknown provider outcomes never invent connection or replay`, async () => {
        for (const outcome of [{ kind: "failed" }, { kind: "unproven" }, "throw"] as const) {
          const store = await stores(kind);
          value(await store.policy.changeStaffedDestination(store.scope, "1", "host/desk-a", "clinic-admin"));
          const app = newCall(store, outcome);
          await app.begin();
          const turn = await app.speak();
          assert.equal(app.requests.length, 1);
          const state = await app.state();
          const transfer = Object.values(state.presentations).find(item => item.kind === "transfer");
          assert.equal(transfer?.status, outcome !== "throw" && outcome.kind === "failed" ? "failed" : "unproven");
          assert.equal(app.spoken.some(text => /connected you|staff have received/i.test(text)), false);
          if (outcome !== "throw" && outcome.kind === "failed") {
            await app.play(turn.delivery);
            assert.match(app.spoken.at(-1)!, /couldn't connect.*can't confirm they've received/);
            const failureNotices = Object.values((await app.state()).presentations)
              .filter(item => item.id === `${transfer!.id}:failureNotice`);
            assert.equal(failureNotices.length, 1);
            assert.equal(failureNotices[0]?.kind, "notice");
            assert.equal(failureNotices[0]?.status, "played");
            value(await app.call.disconnect(now));
          } else {
            assert.equal(turn.delivery.kind, "transferUnproven");
            assert.equal(state.terminal?.reason, "transferUnproven");
            const replay = await app.call.acceptMedia({ sessionId: app.sessionId, sequence: 7, capturedAt: now, bytes: new Uint8Array(640) });
            assert.equal(replay.ok, false);
          }
          assert.equal(app.requests.length, 1);
        }
      });
    }
  } finally {
    await db?.destroy();
    if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin!);
    await admin?.destroy();
  }
});
