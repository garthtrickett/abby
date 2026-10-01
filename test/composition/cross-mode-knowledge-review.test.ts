import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const now = "2026-09-29T10:00:00.000Z";
const answerText = "Parking is behind the clinic.";
const fallbackText = "I can't verify that information right now.";

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

/** E2E-223: one knowledge and review script uses both real storage/privacy modes. */
test("E2E-223 agent knowledge and call review obey standalone and embedded host boundaries",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const adminDb = connectPostgres(adminUrl);
    const names: string[] = [];
    try {
      for (const mode of ["standalone", "embedded"] as const) {
        const databaseName = `abby_knowledge_${mode}_${randomUUID().replaceAll("-", "")}`;
        const target: URL = new URL(adminUrl);
        target.pathname = `/${databaseName}`;
        await sql.raw(`create database "${databaseName}"`).execute(adminDb);
        names.push(databaseName);
        const db = connectPostgres(target.toString());
        try {
          await migrate(db);
          const scope: LocationScope = { tenantId: `knowledge-${mode}`, clinicId: "clinic", locationId: "main" };
          const readiness = async () => ok(true as const);
          const ledger = mode === "standalone" ? new MemoryLedger(readiness)
            : new PostgresLedger(db, undefined, readiness, "unsafeReference");
          const policy = new PostgresPolicyStore(db, referenceDefaultPolicy,
            mode === "standalone" ? "unavailable" : "execute", readiness,
            mode === "embedded", mode === "standalone" ? "standaloneMinimal" : "unsafeReference");
          const host = mode === "standalone" ? new DisabledStandaloneHost() : new ReferenceClinicHost([], []);
          const catalogue = mode === "embedded" ? new MemoryKnowledgeCatalogue() : undefined;
          const reception = new TextReception(ledger, policy, host, undefined, undefined, undefined,
            catalogue ?? host);
          const review = mode === "embedded" ? new CallReview(ledger) : undefined;
          const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope }, policy,
            reception, review);
          const admin = new CommandGateway({ actorRef: "clinic-admin", role: "clinicAdmin", scope }, policy,
            reception, review, undefined, undefined, undefined, catalogue);
          const firstCall = `private-call-before-${mode}`;
          const currentCall = `private-call-current-${mode}`;
          const callerText = `private-caller-text-${mode}`;
          const answer = (callId: string, turnId: string) => ({ kind: "knowledge.answer.v2" as const,
            turn: { callId, turnId, text: callerText, quality: "clear" as const, at: now },
            sourceRefs: ["parking"], proposedText: answerText, now });

          assert.ok(agent.listPermitted().some(item => item.id === "knowledge.answer.v2"));
          assert.equal(agent.listPermitted().some(item => item.id === "knowledge.approve.v1"), false);
          assert.equal(admin.listPermitted().some(item => item.id === "knowledge.approve.v1"), mode === "embedded");
          assert.equal(agent.listPermitted().some(item => item.id === "calls.read.v1"), mode === "embedded");
          failure(await agent.submit({ kind: "knowledge.list.v1" }), "forbidden");
          failure(await agent.submit({ kind: "knowledge.approve.v1", sourceRef: "parking",
            expectedVersion: "1" }), "forbidden");
          const automation = value(await admin.submit({ kind: "settings.automation.enabled.change.v1",
            expectedVersion: "0", enabled: true }));
          assert.equal(automation.kind, "settings");
          value(await reception.startCall(firstCall, scope, now));
          const before = value(await agent.submit(answer(firstCall, "before")));
          assert.equal(before.kind, "knowledgeAnswer");
          assert.equal(JSON.stringify(before).includes(callerText), false);
          assert.equal(JSON.stringify(before).includes(answerText), false);
          let state = value(await reception.read(scope, firstCall));
          assert.equal(state.callerMessages.at(-1), fallbackText);
          assert.deepEqual(state.knowledgeAnswers, []);

          const draftCommand = { kind: "knowledge.draft.save.v1" as const, sourceRef: "parking",
            expectedVersion: "0", ownerRef: "practice-manager", text: answerText,
            effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" };
          if (mode === "standalone") {
            failure(await admin.submit(draftCommand), "forbidden");
            failure(await admin.submit({ kind: "calls.read.v1", callId: firstCall }), "forbidden");
          } else {
            failure(await admin.submit({ ...draftCommand, extra: callerText } as typeof draftCommand), "invalid");
            const draft = value(await admin.submit(draftCommand));
            assert.equal(draft.kind, "knowledgeEntry");
            if (draft.kind !== "knowledgeEntry") throw new Error("knowledge draft reply unavailable");
            assert.equal(draft.entry.status, "draft");
            failure(await admin.submit({ kind: "knowledge.approve.v1", sourceRef: "parking",
              expectedVersion: "0" }), "versionConflict");
            const approved = value(await admin.submit({ kind: "knowledge.approve.v1", sourceRef: "parking",
              expectedVersion: draft.entry.version }));
            assert.equal(approved.kind, "knowledgeEntry");
            const listed = value(await admin.submit({ kind: "knowledge.list.v1" }));
            assert.equal(listed.kind, "knowledgeList");
            if (listed.kind !== "knowledgeList") throw new Error("knowledge list reply unavailable");
            assert.equal(listed.entries.at(-1)?.status, "approved");
          }

          value(await reception.startCall(currentCall, scope, now));
          const malformedAnswer = { ...answer(currentCall, "invalid"), extra: callerText } as ReturnType<typeof answer>;
          failure(await agent.submit(malformedAnswer), "invalid");
          const current = value(await agent.submit(answer(currentCall, "current")));
          assert.equal(current.kind, "knowledgeAnswer");
          assert.equal(JSON.stringify(current).includes(callerText), false);
          assert.equal(JSON.stringify(current).includes(answerText), false);
          state = value(await reception.read(scope, currentCall));
          assert.equal(state.callerMessages.at(-1), mode === "embedded" ? answerText : fallbackText);
          assert.equal(state.knowledgeAnswers.length, mode === "embedded" ? 1 : 0);
          assert.equal(Object.keys(state.actions).length, 0);
          assert.equal(Object.keys(state.staffItems).length, 0);

          if (mode === "embedded") {
            const summary = value(await agent.submit({ kind: "calls.read.v1", callId: currentCall }));
            assert.equal(summary.kind, "callSummary");
            if (summary.kind !== "callSummary") throw new Error("call review reply unavailable");
            assert.deepEqual(summary.call.knowledgeAnswers,
              [{ sourceRef: "parking", version: "2", ownerRef: "practice-manager" }]);
            assert.equal(JSON.stringify(summary).includes(callerText), false);
            assert.equal(JSON.stringify(summary).includes(answerText), false);
            const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent",
              scope: { ...scope, tenantId: "another-tenant" } }, policy, reception, review);
            failure(await foreign.submit({ kind: "calls.read.v1", callId: currentCall }), "callUnknown");
            const reopened = connectPostgres(target.toString());
            try {
              const recovered = value(await new CallReview(new PostgresLedger(reopened, undefined, readiness,
                "unsafeReference")).read(currentCall, scope));
              assert.deepEqual(recovered.knowledgeAnswers, summary.call.knowledgeAnswers);
            } finally { await reopened.destroy(); }
          } else {
            failure(await agent.submit({ kind: "calls.read.v1", callId: currentCall }), "forbidden");
            const stored = await sql<{ count: number }>`select count(*)::int as count from calls`.execute(db);
            assert.equal(stored.rows[0]?.count, 0);
            const canaries = [{ label: "call", value: currentCall }, { label: "caller", value: callerText },
              { label: "approved_answer", value: answerText }];
            assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
            assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
            (ledger as MemoryLedger).dispose();
            failure(await ledger.read(currentCall, scope), "callUnknown");
          }
        } finally { await db.destroy(); }
      }
    } finally {
      try { for (const name of names.reverse()) await sql.raw(`drop database "${name}" with (force)`).execute(adminDb); }
      finally { await adminDb.destroy(); }
    }
  });
