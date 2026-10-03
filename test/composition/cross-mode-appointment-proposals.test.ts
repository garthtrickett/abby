import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { proposalCanaries, proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import type { ProposalCommand, ProposalOperation } from "../support/agent-appointment-proposals.ts";

for (const mode of ["standalone", "embedded"] as const) {
  test(`E2E-261 ${mode} agent appointment proposals preserve caller authority and their actual storage guarantee`,
    { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    assert.ok(process.env.DATABASE_URL);
    const adminDb = connectPostgres(process.env.DATABASE_URL);
    const name = `abby_agent_proposals_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
    let db: ReturnType<typeof connectPostgres> | undefined, created = false;
    try {
      await sql.raw(`create database "${name}"`).execute(adminDb); created = true;
      db = connectPostgres(url.toString()); await migrate(db);
      const hostMode = mode === "embedded" ? "execute" : "unavailable";
      const ledger = mode === "embedded" ? new PostgresLedger(db, suggested => suggested, proposalReady, "unsafeReference")
        : new MemoryLedger(proposalReady);
      const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, hostMode, proposalReady,
        mode === "embedded", mode === "embedded" ? "unsafeReference" : "standaloneMinimal", false,
        { cancellation: hostMode, rescheduling: hostMode, intake: hostMode });
      const app = proposalHarness({ tenantId: `postgres-agent-${mode}`, clinicId: "clinic", locationId: "main" }, mode, { ledger, policy });
      await app.enable();
      const commands: ProposalCommand[] = [];
      const readyAction = async (command: ProposalCommand) => {
        const proposal = resultValue(await app.agent.submit(command));
        assert.ok("progress" in proposal);
        for (const canary of proposalCanaries) assert.equal(JSON.stringify(proposal).includes(canary), false);
        const action = Object.values(resultValue(await app.runtime.read(command.turn.callId)).actions)[0];
        assert.ok(action);
        const writes = app.host.writes.length;
        resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
        assert.equal(app.host.writes.length, writes);
        resultValue(await app.runtime.startPresentation(command.turn.callId, action.presentationId, command.turn.sessionId, proposalNow));
        resultValue(await app.runtime.resolvePresentation(command.turn.callId, action.presentationId, "played", command.turn.sessionId, proposalNow));
        resultValue(await app.reception.affirm(app.scope, { ...command.turn, turnId: "caller-yes", text: "Yes" },
          action.key, action.digest, proposalNow));
        assert.equal(app.host.writes.length, writes);
        return action;
      };
      for (const operation of ["cancel", "reschedule", "intake"] as readonly ProposalOperation[]) {
        const command = await app.admit(operation); commands.push(command);
        const foreign = app.gateway("agent", { ...app.scope, tenantId: "another-tenant" });
        assert.deepEqual(await foreign.submit(command), { ok: false, error: { kind: "callUnknown" } });
        if (mode === "standalone") {
          const reply = resultValue(await app.agent.submit(command));
          assert.ok("progress" in reply); assert.deepEqual(reply.progress.actions, []);
          resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
          assert.equal(app.host.writes.length, 0); assert.equal(app.host.evidenceReads, 0);
          continue;
        }
        const before = app.host.writes.length;
        const action = await readyAction(command);
        const settled = resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
        assert.equal(settled.actions[action.key]?.status, "committed");
        assert.equal(app.host.writes.length, before + 1);
        const reopened = connectPostgres(url.toString());
        try {
          const recoveredLedger = new PostgresLedger(reopened, suggested => suggested, proposalReady, "unsafeReference");
          const recovered = resultValue(await recoveredLedger.read(command.turn.callId, app.scope));
          assert.equal(recovered.actions[action.key]?.status, "committed");
          const recoveredReception = new TextReception(recoveredLedger, policy, app.host);
          const recoveredAgent = new CommandGateway({ actorRef: "recovered-agent", role: "agent", scope: app.scope }, policy, recoveredReception);
          resultValue(await recoveredAgent.submit(command));
          resultValue(await recoveredReception.drain(app.scope, command.turn.callId, proposalNow));
          assert.equal(app.host.writes.length, before + 1);
        } finally { await reopened.destroy(); }

        const stoppedCommand = await app.admit(operation, "stopped");
        const stoppedAction = await readyAction(stoppedCommand);
        const stopped = resultValue(await app.admin.submit({ kind: "calls.writes.stop.v1", reason: "synthetic incident" }));
        assert.equal(stopped.kind, "writeStop"); if (stopped.kind !== "writeStop") assert.fail("unexpected stop reply");
        assert.equal(stopped.status.stopped, true);
        const blocked = resultValue(await app.reception.drain(app.scope, stoppedCommand.turn.callId, proposalNow));
        assert.equal(blocked.actions[stoppedAction.key]?.status, "unsupported");
        assert.equal(app.host.writes.length, before + 1);
        resultValue(await app.admin.submit({ kind: "calls.writes.resume.v1", expectedVersion: stopped.status.version,
          reason: "synthetic recovery" }));
        resultValue(await app.agent.submit(stoppedCommand));
        resultValue(await app.reception.drain(app.scope, stoppedCommand.turn.callId, proposalNow));
        assert.equal(app.host.writes.length, before + 1, "resuming must not replay a stopped proposal");
      }
      const stored = await sql<{ count: number }>`select count(*)::int as count from calls`.execute(db);
      assert.equal(stored.rows[0]?.count, mode === "embedded" ? 6 : 0);
      if (mode === "standalone") {
        const canaries = [
          ...proposalCanaries.map((value, index) => ({ label: `private_${index}`, value })),
          ...commands.map((command, index) => ({ label: `call_${index}`, value: command.turn.callId })),
        ];
        assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
        assert.deepEqual(await scanDisposableBackupCanaries(url.toString(), canaries), []);
        (ledger as MemoryLedger).dispose();
        for (const command of commands) assert.deepEqual(await ledger.read(command.turn.callId, app.scope),
          { ok: false, error: { kind: "callUnknown" } });
      }
    } finally {
      await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(adminDb); }
      finally { await adminDb.destroy(); }
    }
  });
}
