import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { bookingSessionFixture } from "../support/booking-session.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

test("E2E-283 E2E-284 actual admitted booking session/menu with actual provider and verification budgets leaves selections, appointment work and review context outside PostgreSQL and backups",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), databaseName = `abby_book_session_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, database: ReturnType<typeof connectPostgres> | undefined;
    let f: Awaited<ReturnType<typeof bookingSessionFixture>> | undefined;
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      database = connectPostgres(target.toString()); await migrate(database);
      const scope = { tenantId: `owner-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
      f = await bookingSessionFixture({ scope, verificationBudget: new PostgresPatientVerificationBudget(database, scope),
        budget: new PostgresClinikoRequestBudget(database, { apiKey: "synthetic-session-au5" }) });
      const proofRef = await f.verify();
      assert.ok((await f.readMenu()).ok); await f.playPending(); assert.ok((await f.select()).ok);
      const action = Object.values((await f.state()).actions)[0]!;
      assert.equal(action.mutation.request.kind, "book");
      const offerRef = action.mutation.request.kind === "book" ? action.mutation.request.offer.offerRef : "";
      assert.ok((await f.confirm()).ok); await f.drain();
      assert.equal(f.posts, 1); assert.equal(f.traffic.filter(value => value === "POST /v1/individual_appointments").length, 1);
      assert.equal((await f.discovery()).pending.length, 1, "review remains Cliniko-owned and is not closed automatically");
      assert.ok(f.mail[0], "the real verification journey delivered its synthetic email");
      const canaries = [...verificationCanaries, f.mail[0].code, proofRef, offerRef, f.callId, f.sessionId, "2026-10-08T04:00:00.000Z"]
        .map((value, i) => ({ label: `target_${i}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(database, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await database.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom("patient_phone_index").selectAll().execute(), []);
      const requests = await database.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(requests.length, 1); assert.ok(Array.isArray(requests[0]!.sent_at_ms));
      assert.equal(requests[0]!.sent_at_ms.length, f.allTraffic.length, "one API-user bucket covers every provider request");
      const saved = await database.selectFrom("patient_verification_budgets").selectAll().execute();
      assert.equal(saved.length, 2); for (const row of saved) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
    } finally {
      await f?.close(); await database?.destroy();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
