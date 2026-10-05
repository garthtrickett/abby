import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { intakeCredential, intakeDraft } from "../support/intake-edge.ts";
import { intakeBookingCanaries, intakeBookingSessionFixture } from "../support/intake-booking-session.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const outcome of ["success", "bookingLoss"] as const) test(`E2E-296 ${outcome} uses shared PostgreSQL budgets while draft, proof, booking and review work remain absent from tables and backup`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), name = `abby_intake_book_${randomUUID().replaceAll("-", "")}`, target = new URL(adminUrl); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined, f: Awaited<ReturnType<typeof intakeBookingSessionFixture>> | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true; db = connectPostgres(target.toString()); await migrate(db);
      const scope = { tenantId: "intake-policy", clinicId: "clinic", locationId: "main" };
      f = await intakeBookingSessionFixture({ rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: intakeCredential, maxPerMinute: 200 }),
        verificationBudget: new PostgresPatientVerificationBudget(db, scope) });
      const draft = await f.register(); await f.playPending(); resultValue(await f.readMenu()); await f.playPending(); resultValue(await f.select());
      resultValue(await f.confirm("book")); if (outcome === "bookingLoss") f.provider.fail(outcome); resultValue(await f.drain());
      const state = await f.state(), book = Object.values(state.actions).find(action => action.kind === "book")!;
      assert.equal(book.status, outcome === "success" ? "committed" : "uncertain"); assert.equal(f.provider.patientPosts, 1); assert.equal(f.provider.bookingPosts, 1);
      assert.equal(f.provider.recalls.length, 1);
      const request = book.mutation.request; assert.equal(request.kind, "book"); if (request.kind !== "book") throw new Error("missing book action");
      const values = [...Object.values(intakeDraft), f.mail[0]!.code, f.callId, f.sessionId, draft, book.key, book.digest, request.patient.verificationRef,
        request.offer.offerRef, request.offer.startsAt, String(f.provider.recalls[0]!.notes), String(f.provider.appointment!.notes), "private intake booking provider notes"];
      const canaries = intakeBookingCanaries(values, "intake_booking");
      for (let offset = 0; offset < canaries.length; offset += 12) {
        assert.deepEqual(await scanPatientDataCanaries(db, canaries.slice(offset, offset+12)), { ok: true, value: [] });
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.slice(offset, offset+12)), []);
      }
      assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []); assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      const provider = await db.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(provider.length, 1);
      assert.equal((provider[0]!.sent_at_ms as number[]).length, f.provider.traffic.length);
      const codes = await db.selectFrom("patient_verification_budgets").selectAll().execute();
      assert.deepEqual(codes.map(row => [row.kind, row.attempts]).sort(), [["answer", 1], ["issue", 1]]);
      await f.close(); for (let offset = 0; offset < canaries.length; offset += 12)
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.slice(offset, offset+12)), []);
    } finally {
      await f?.close(); await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
    }
  });
