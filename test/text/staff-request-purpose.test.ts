import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import type { StaffRequestHost } from "../../src/core/host.ts";
import { staffRequestSubjects, staffSubjectUnavailable } from "../../src/core/staff-request-subject.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-323 typed staff commands cancel proposals before host work, fence private time and reject corrupt durable categories", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `staff-purpose-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? {
        ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }),
      } : undefined);
      let clock = proposalNow, reads = 0;
      const host = Object.assign(f.host, { prepareStaffRequest: (async () => ({ ok: false, error: { kind: "staffUnavailable" } })) as StaffRequestHost["prepareStaffRequest"] });
      try {
        await f.enable();
        const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "staff-purpose-agent", role: "agent", scope }, f.policy, reception);
        let purposeIndex = 0;
        for (const requestSubject of staffRequestSubjects) {
          const proposal = await f.admit("cancel", `purpose-${purposeIndex++}`); resultValue(await f.agent.submit(proposal));
          const command = { kind: "staff.requests.prepare.v1" as const, requestSubject, now: proposalNow,
            turn: { ...proposal.turn, turnId: "staff-ask", text: "Please send that request." } };
          host.prepareStaffRequest = async query => {
            reads++; assert.equal(query.requestSubject, requestSubject);
            assert.ok(Object.values(resultValue(await f.runtime.read(proposal.turn.callId)).actions).every(action => action.status === "canceled"));
            return { ok: true, value: { kind: "ready", requestSubject } };
          };
          const before = resultValue(await f.runtime.read(proposal.turn.callId)), count = reads;
          for (const bad of [ { ...command, requestSubject: "invoiceAmount" }, { ...command, turn: { ...command.turn, sessionId: "foreign" } },
            { ...command, turn: { ...command.turn, quality: "needsClarification" } } ]) assert.equal((await agent.submit(bad as never)).ok, false);
          const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "other" } }, f.policy, reception);
          assert.equal((await foreign.submit(command)).ok, false); assert.equal(reads, count);
          assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
          resultValue(await agent.submit(command)); resultValue(await reception.drain(scope, proposal.turn.callId, proposalNow));
          const saved = resultValue(await f.runtime.read(proposal.turn.callId)), item = Object.values(saved.staffItems).at(-1)!;
          assert.equal(item.requestSubject, requestSubject); assert.equal(item.status, "open");
          assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).filter(task => task.taskKey === item.key).length, 1);
          resultValue(await agent.submit(command)); resultValue(await reception.drain(scope, proposal.turn.callId, proposalNow));
          assert.equal(f.host.tasks(scope).filter(task => task.taskKey === item.key).length, 1);
          const progress = resultValue(await agent.submit({ kind: "staff.requests.outcome.v1", now: proposalNow, turn: { ...command.turn, turnId: "staff-outcome" } }));
          assert.ok(!JSON.stringify(progress).includes(requestSubject), "public agent progress excludes patient-specific request purpose");
          if (adapter === "postgres") {
            const stable = resultValue(await f.runtime.read(proposal.turn.callId));
            for (const corrupt of [{ ...item, requestSubject: "invoiceAmount" }, { ...item, linkedActionKey: "clinical-action" }, { ...item, reason: "systemFailure" }]) {
              const bad = { ...stable, staffItems: { ...stable.staffItems, [item.key]: corrupt } };
              await sql`update calls set state = ${JSON.stringify(bad)}::jsonb where call_id = ${proposal.turn.callId}`.execute(db);
              const result = await f.ledger.read(proposal.turn.callId, scope); assert.equal(result.ok, false);
              if (!result.ok) assert.equal(result.error.kind, "storageCorrupt");
            }
            await sql`update calls set state = ${JSON.stringify(stable)}::jsonb where call_id = ${proposal.turn.callId}`.execute(db);
          }
        }
        const proposal = await f.admit("cancel", "malformed-host");
        host.prepareStaffRequest = async () => { reads++; return { ok: true, value: { kind: "ready", requestSubject: "chargeReview" } }; };
        const command = { kind: "staff.requests.prepare.v1" as const, requestSubject: "invoiceCopy" as const, now: proposalNow,
          turn: { ...proposal.turn, turnId: "wrong-host-subject", text: "Please send my invoice." } };
        resultValue(await agent.submit(command));
        assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), staffSubjectUnavailable("invoiceCopy"));
        assert.equal(Object.keys(resultValue(await f.runtime.read(proposal.turn.callId)).staffItems).length, 0);
        for (const value of [null, { kind: "sendInvoice" }, { kind: "ready", requestSubject: "invoiceAmount" }]) {
          host.prepareStaffRequest = async () => { reads++; return { ok: true, value } as never; };
          resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: `malformed-${reads}` } }));
          assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), staffSubjectUnavailable("invoiceCopy"));
          assert.equal(Object.keys(resultValue(await f.runtime.read(proposal.turn.callId)).staffItems).length, 0);
        }
        const stable = resultValue(await f.runtime.read(proposal.turn.callId)), count = reads; clock = "2026-10-03T11:00:00.000Z";
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "public-clock-replay" } })).ok, false);
        assert.equal(reads, count); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), stable);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const results = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
});

test("E2E-323 held staff preparations cannot publish after interruption, lease expiry or a newer caller turn", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (mode: "abort" | "expired" | "revision") => {
      const scope = { tenantId: `staff-purpose-held-${mode}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", { ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }) });
      await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
      const host = Object.assign(f.host, { prepareStaffRequest: (async () => ({ ok: false, error: { kind: "staffUnavailable" } })) as StaffRequestHost["prepareStaffRequest"] });
      let clock = proposalNow, release!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      host.prepareStaffRequest = async () => { entered(); await held; return { ok: true, value: { kind: "ready", requestSubject: "invoiceCopy" } }; };
      const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => clock);
      const abort = new AbortController(), turn = { ...proposal.turn, turnId: "held-staff", text: "Please send my invoice." };
      const pending = reception.requestStaff(scope, turn, undefined, proposalNow, undefined, abort.signal, "invoiceCopy");
      try {
        await started;
        const admitted = resultValue(await f.runtime.read(proposal.turn.callId));
        assert.ok(Object.values(admitted.actions).every(action => action.status === "canceled"));
        if (mode === "abort") abort.abort();
        else if (mode === "expired") clock = "2026-10-03T11:00:00.000Z";
        else resultValue(await f.runtime.acceptTurn({ ...turn, turnId: "newer", text: "Never mind." }, { kind: "clarify" }, proposalNow));
        const stable = resultValue(await f.runtime.read(proposal.turn.callId)); release();
        const result = await pending; assert.equal(result.ok, false);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), stable);
        assert.equal(f.host.tasks(scope).length, 0); assert.equal(f.host.writes.length, 0);
      } finally { release(); await pending; }
    };
    const results = await Promise.allSettled([run("abort"), run("expired"), run("revision")]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
});
