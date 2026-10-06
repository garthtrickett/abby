import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import type { StaffRequestHost, StaffReviewProcessHost } from "../../src/core/host.ts";
import type { StaffReviewProcess } from "../../src/core/staff-review-process.ts";
import { ok } from "../../src/core/model.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

const cadence = /approved process calls for reviewing saved requests every 30 minutes/;

test("E2E-326 native status uses private time, exact public evidence and current policy in memory and PostgreSQL", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `staff-review-${adapter}`, clinicId: "clinic", locationId: "main" };
      const base = new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" });
      let enabled = true, policyUnavailable = false;
      const policy = new Proxy(base, { get(target, key) {
        if (key === "read") return async (...args: Parameters<typeof base.read>) => {
          if (policyUnavailable) throw new Error("public policy unavailable");
          const found = await base.read(...args); return found.ok ? ok({ ...found.value, staffWorkEnabled: enabled }) : found;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      const f = proposalHarness(scope, "embedded", { ledger: adapter === "postgres" ? new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference") : new MemoryLedger(proposalReady), policy });
      // The reference ledger is explicitly unsafe lab storage; no standalone PHI authorization.
      let clock = proposalNow, reads = 0;
      const host = Object.assign(f.host, { prepareStaffRequest: (async () => ok({ kind: "ready" })) as StaffRequestHost["prepareStaffRequest"],
        readStaffReviewProcess: (async () => { throw new Error("not initialized"); }) as StaffReviewProcessHost["readStaffReviewProcess"] });
      try {
        await f.enable(); const admitted = await f.admit("cancel", "staff");
        const reception = new TextReception(f.ledger, policy, host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "staff-review-agent", role: "agent", scope }, policy, reception);
        const turn = { ...admitted.turn, turnId: "request", text: "Please send that request." };
        resultValue(await agent.submit({ kind: "staff.requests.prepare.v1", turn, now: proposalNow })); resultValue(await reception.drain(scope, turn.callId, proposalNow));
        const initial = resultValue(await f.runtime.read(turn.callId)), item = Object.values(initial.staffItems).at(-1)!;
        assert.equal(item.status, "open"); assert.equal(f.host.tasks(scope).length, 1);
        const snapshot: StaffReviewProcess = { scope, callId: turn.callId, sessionId: turn.sessionId!, policyVersion: initial.policy.policyVersion,
          taskKey: item.key, approvalRevision: "public-process-v1", cadenceMinutes: 30, observedAt: proposalNow, expiresAt: initial.sessionLease!.expiresAt };
        const query = (suffix: string) => ({ kind: "staff.requests.outcome.v1" as const, now: proposalNow, turn: { ...turn, turnId: `query-${suffix}`, text: "Was it saved?" } });
        const setRead = (value: unknown) => { host.readStaffReviewProcess = async input => { reads++; assert.deepEqual(Object.keys(input).sort(), ["callId", "expectedConversationRevision", "policyVersion", "scope", "sessionId", "signal", "taskKey"]); return ok(value as StaffReviewProcess); }; };
        setRead(snapshot); const progress = resultValue(await agent.submit(query("valid")));
        assert.match(resultValue(await f.runtime.read(turn.callId)).callerMessages.at(-1)!, cadence);
        assert.ok(!JSON.stringify(progress).includes("public-process-v1"));
        const countBeforeDuplicate = reads;
        resultValue(await agent.submit(query("valid"))); assert.equal(reads, countBeforeDuplicate);
        for (const bad of [{ ...query("bad-session"), turn: { ...turn, turnId: "bad-session", sessionId: "foreign" } }, { ...query("bad-time"), now: "invalid" }])
          assert.equal((await agent.submit(bad)).ok, false);
        assert.equal(reads, countBeforeDuplicate);
        const invalid = [null, { ...snapshot, scope: { ...scope, locationId: "other" } }, { ...snapshot, callId: "foreign" }, { ...snapshot, sessionId: "foreign" },
          { ...snapshot, taskKey: "foreign" }, { ...snapshot, policyVersion: "foreign" }, { ...snapshot, cadenceMinutes: 0 }, { ...snapshot, cadenceMinutes: 1441 },
          { ...snapshot, cadenceMinutes: 1.5 }, { ...snapshot, observedAt: "2026-10-03T10:00:01.000Z" }, { ...snapshot, observedAt: "2026-10-03T09:59:00.000Z" },
          { ...snapshot, expiresAt: proposalNow }, { ...snapshot, expiresAt: "2026-10-04T11:00:00.000Z" }, { ...snapshot, reviewOwnerRef: "must-not-leak" }];
        for (const [index, value] of invalid.entries()) {
          setRead(value); resultValue(await agent.submit(query(`invalid-${index}`)));
          const text = resultValue(await f.runtime.read(turn.callId)).callerMessages.at(-1)!;
          assert.match(text, /was saved/); assert.doesNotMatch(text, /approved process|must-not-leak/);
        }
        const heldModes = ["abort", "revision", "expired", "policy", "policyUnavailable"] as const;
        for (const mode of heldModes) {
          clock = proposalNow; enabled = true; policyUnavailable = false;
          let release!: () => void, entered!: () => void;
          const started = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
          host.readStaffReviewProcess = async () => { reads++; entered(); await hold; return ok(snapshot); };
          const abort = new AbortController(), cmd = query(`held-${mode}`);
          const pending = reception.staffOutcome(scope, cmd.turn, proposalNow, undefined, abort.signal);
          try {
            await started;
            if (mode === "abort") abort.abort();
            if (mode === "revision") resultValue(await f.runtime.acceptTurn({ ...turn, turnId: "newer", text: "Never mind." }, { kind: "clarify" }, proposalNow));
            if (mode === "expired") clock = initial.sessionLease!.expiresAt;
            if (mode === "policy") enabled = false;
            if (mode === "policyUnavailable") policyUnavailable = true;
            const stable = resultValue(await f.runtime.read(turn.callId)); release(); const result = await pending;
            if (mode === "policy" || mode === "policyUnavailable") { assert.equal(result.ok, true); assert.doesNotMatch(resultValue(await f.runtime.read(turn.callId)).callerMessages.at(-1)!, /approved process/); }
            else { assert.equal(result.ok, false); assert.deepEqual(resultValue(await f.runtime.read(turn.callId)), stable); }
          } finally { release(); await pending; }
        }
        enabled = true; policyUnavailable = false; clock = initial.sessionLease!.expiresAt; const before = resultValue(await f.runtime.read(turn.callId)), count = reads;
        assert.equal((await agent.submit(query("caller-clock-replay"))).ok, false); assert.equal(reads, count); assert.deepEqual(resultValue(await f.runtime.read(turn.callId)), before);
        assert.equal(f.host.tasks(scope).length, 1); assert.equal(f.host.writes.length, 0); assert.deepEqual(before.staffItems, initial.staffItems);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  });
});
