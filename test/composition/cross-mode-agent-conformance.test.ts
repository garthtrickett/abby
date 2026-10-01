import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { CallState, LocationScope, Result } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
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
const expiresAt = "2026-09-29T11:00:00.000Z";

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function error<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

/** E2E-222: one agent command script runs through the real strict and buyer-owned adapters. */
test("E2E-222 agent booking authority agrees across transient standalone and durable embedded compositions",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const adminDb = connectPostgres(adminUrl);
    const names: string[] = [];
    try {
      for (const mode of ["standalone", "embedded"] as const) {
        const databaseName = `abby_conformance_${mode}_${randomUUID().replaceAll("-", "")}`;
        const target: URL = new URL(adminUrl);
        target.pathname = `/${databaseName}`;
        await sql.raw(`create database "${databaseName}"`).execute(adminDb);
        names.push(databaseName);
        const db = connectPostgres(target.toString());
        try {
          await migrate(db);
          const scope: LocationScope = { tenantId: `conformance-${mode}`, clinicId: "clinic", locationId: "main" };
          const patientRef = `private-patient-${mode}`;
          const verificationRef = `private-proof-${mode}`;
          const callerText = `private-caller-${mode}`;
          const callId = `private-call-${mode}`;
          const readiness = async () => ok(true as const);
          const ledger = mode === "standalone" ? new MemoryLedger(readiness)
            : new PostgresLedger(db, undefined, readiness, "unsafeReference");
          const policy = new PostgresPolicyStore(db, referenceDefaultPolicy,
            mode === "standalone" ? "unavailable" : "execute", readiness,
            mode === "embedded", mode === "standalone" ? "standaloneMinimal" : "unsafeReference");
          const embeddedHost = mode === "embedded" ? new ReferenceClinicHost(
            [{ scope, patientRef, verificationRef, expiresAt }],
            [{ scope, offerRef: "offer-one", serviceRef: "physio",
              startsAt: "2026-10-01T10:00:00.000Z", expiresAt }]) : undefined;
          const standaloneHost = mode === "standalone" ? new DisabledStandaloneHost() : undefined;
          const reception = embeddedHost
            ? createEmbeddedTextComposition(ledger, policy, embeddedHost)
            : new TextReception(ledger, policy, standaloneHost!, undefined, undefined, undefined, standaloneHost!);
          const agent = new CommandGateway({ actorRef: "host-agent", role: "agent", scope }, policy, reception);
          const admin = new CommandGateway({ actorRef: "clinic-admin", role: "clinicAdmin", scope }, policy,
            reception, undefined, undefined, undefined, ledger);

          assert.ok(agent.listPermitted().some(item => item.id === "booking.propose.v2"));
          assert.ok(!agent.listPermitted().some(item => item.id === "settings.appointments.booking.enabled.change.v1"));
          error(await agent.submit({ kind: "settings.appointments.booking.enabled.change.v1",
            expectedVersion: "0", enabled: true }), "forbidden");
          const defaultPolicy = value(await agent.submit({ kind: "settings.read.v1" }));
          assert.equal(defaultPolicy.kind, "settings");
          assert.equal(defaultPolicy.policy.capabilities.book, "unavailable");
          const enabled = value(await admin.submit({ kind: "settings.appointments.booking.enabled.change.v1",
            expectedVersion: "0", enabled: true }));
          assert.equal(enabled.kind, "settings");
          assert.equal(enabled.policy.capabilities.book, mode === "embedded" ? "execute" : "unavailable");
          error(await admin.submit({ kind: "settings.appointments.booking.enabled.change.v1",
            expectedVersion: "0", enabled: false }), "versionConflict");

          value(await reception.startCall(callId, scope, now));
          const command = { kind: "booking.propose.v2" as const,
            turn: { callId, turnId: "first", text: callerText, quality: "clear" as const, at: now },
            verificationRef, offerRef: "offer-one", now };
          error(await agent.submit({ ...command, extra: patientRef } as typeof command), "invalid");
          const proposed = value(await agent.submit(command));
          assert.equal(proposed.kind, "bookingProposal");
          assert.equal(JSON.stringify(proposed).includes(patientRef), false);
          assert.equal(JSON.stringify(proposed).includes(verificationRef), false);
          assert.equal(JSON.stringify(proposed).includes(callerText), false);
          let state = value(await reception.read(scope, callId));
          const action = Object.values(state.actions)[0];
          if (mode === "standalone") {
            assert.equal(action, undefined);
            assert.equal(Object.keys(state.staffItems).length, 0);
            assert.match(state.callerMessages.at(-1) ?? "", /can't complete that request/);
          } else {
            assert.ok(action);
            assert.equal(action.status, "awaitingConfirmation");
            assert.equal(embeddedHost!.bookings(scope).length, 0);
            assert.equal(embeddedHost!.bookingEvidenceReads(), 1);
            value(await reception.drain(scope, callId, now));
            assert.equal(embeddedHost!.bookings(scope).length, 0);
            value(await reception.acknowledgeTextPresentation(scope, callId, action.presentationId));
            value(await reception.drain(scope, callId, now));
            assert.equal(embeddedHost!.bookings(scope).length, 0);
            state = value(await reception.affirm(scope, { callId, turnId: "yes", text: "Yes, book it",
              quality: "clear", at: now }, action.key, action.digest, now));
            assert.equal(state.actions[action.key]?.status, "ready");
            assert.equal(embeddedHost!.bookings(scope).length, 0);
            state = value(await reception.drain(scope, callId, now));
            assert.equal(state.actions[action.key]?.status, "committed");
            assert.equal(embeddedHost!.bookings(scope).length, 1);
          }

          const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent",
            scope: { ...scope, tenantId: "another-tenant" } }, policy, reception);
          error(await foreign.submit({ ...command, turn: { ...command.turn, turnId: "foreign" } }), "callUnknown");
          error(await agent.submit({ kind: "calls.writes.stop.v1", reason: "synthetic incident" }), "forbidden");
          const stoppedCallId = `${callId}-stopped`;
          value(await reception.startCall(stoppedCallId, scope, now));
          const stoppedProposal = value(await agent.submit({ ...command,
            turn: { ...command.turn, callId: stoppedCallId, turnId: "stopped" } }));
          assert.equal(stoppedProposal.kind, "bookingProposal");
          const pending = value(await reception.read(scope, stoppedCallId));
          const pendingAction = Object.values(pending.actions)[0];
          if (mode === "embedded") {
            assert.ok(pendingAction);
            value(await reception.acknowledgeTextPresentation(scope, stoppedCallId, pendingAction.presentationId));
            const affirmed = value(await reception.affirm(scope, { callId: stoppedCallId, turnId: "stopped-yes",
              text: "Yes, book it", quality: "clear", at: now }, pendingAction.key, pendingAction.digest, now));
            assert.equal(affirmed.actions[pendingAction.key]?.status, "ready");
          } else assert.equal(pendingAction, undefined);
          const stopped = value(await admin.submit({ kind: "calls.writes.stop.v1", reason: "synthetic incident" }));
          assert.equal(stopped.kind, "writeStop");
          assert.equal(stopped.status.stopped, true);
          if (mode === "embedded") {
            const blocked = value(await reception.drain(scope, stoppedCallId, now));
            assert.equal(blocked.actions[pendingAction!.key]?.status, "unsupported");
            assert.equal(embeddedHost!.bookings(scope).length, 1);
            assert.ok(!blocked.callerMessages.some(message => message.includes("booking is confirmed")));
          } else {
            const blocked = value(await reception.read(scope, stoppedCallId));
            assert.equal(Object.keys(blocked.actions).length, 0);
          }

          const stored = await sql<{ count: number }>`select count(*)::int as count from calls`.execute(db);
          assert.equal(stored.rows[0]?.count, mode === "embedded" ? 2 : 0);
          if (mode === "standalone") {
            assert.deepEqual(await scanPatientDataCanaries(db, [
              { label: "call", value: callId }, { label: "caller", value: callerText },
              { label: "patient", value: patientRef }, { label: "proof", value: verificationRef },
            ]), { ok: true, value: [] });
            assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
              { label: "call", value: callId }, { label: "caller", value: callerText },
              { label: "patient", value: patientRef }, { label: "proof", value: verificationRef },
            ]), []);
            (ledger as MemoryLedger).dispose();
            error(await ledger.read(callId, scope), "callUnknown");
          } else {
            const reopened = connectPostgres(target.toString());
            try {
              const recovered = value(await new PostgresLedger(reopened, undefined, readiness, "unsafeReference")
                .read(callId, scope));
              assert.equal(Object.values(recovered.actions)[0]?.status, "committed");
              assert.equal((recovered as CallState).policy.capabilities.book, "execute");
              const unresolved = value(await new PostgresLedger(reopened, undefined, readiness, "unsafeReference")
                .read(stoppedCallId, scope));
              assert.equal(Object.values(unresolved.actions)[0]?.status, "unsupported");
            } finally { await reopened.destroy(); }
          }
        } finally { await db.destroy(); }
      }
    } finally {
      try { for (const name of names.reverse()) await sql.raw(`drop database "${name}" with (force)`).execute(adminDb); }
      finally { await adminDb.destroy(); }
    }
  });
