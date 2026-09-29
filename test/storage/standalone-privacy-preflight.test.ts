import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { checkStandaloneTextDatabase } from "../../src/storage/standalone-privacy-preflight.ts";

test("E2E-126 text: standalone CLI refuses known legacy patient-data surfaces before accepting caller text", async () => {
  assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1");
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString);
  const admin = connectPostgres(connectionString);
  const name = `abby_privacy_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(connectionString);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    assert.deepEqual(await checkStandaloneTextDatabase(db), { ok: true, value: true });

    const scope = { tenantId: "privacy-preflight", clinicId: "clinic", locationId: "frontdesk" };
    const callId = randomUUID();
    const app = createStandaloneTextComposition(db);
    const reception = app.reception;
    assert.equal((await reception.startCall(callId, scope)).ok, true);
    const at = "2026-10-01T00:00:00Z";
    const fallback = await reception.proposeBooking(scope,
      { callId, turnId: randomUUID(), text: "Need an appointment", quality: "clear", at },
      randomUUID(), randomUUID(), at);
    assert.equal(fallback.ok, true);
    if (!fallback.ok) return;
    assert.ok(fallback.value.pendingPresentationId);
    assert.equal((await reception.acknowledgeTextPresentation(scope, callId,
      fallback.value.pendingPresentationId)).ok, true);
    assert.equal((await app.policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok, true);
    assert.deepEqual(await checkStandaloneTextDatabase(db), { ok: true, value: true });

    const privateText = `private-patient-note-${randomUUID()}`;
    await sql`insert into call_events (call_id, tenant_id, sequence, kind, payload)
      values (${callId}, ${scope.tenantId}, 99, 'callerTurn', ${JSON.stringify({ turnId: randomUUID(),
        interpretation: "clarify", privateText })}::jsonb)`.execute(db);
    assert.deepEqual(await checkStandaloneTextDatabase(db),
      { ok: false, error: { kind: "unsafeExistingData", areas: ["callEvents"] } });
    await sql`delete from call_events where call_id = ${callId} and sequence = 99`.execute(db);
    assert.deepEqual(await checkStandaloneTextDatabase(db), { ok: true, value: true });

    const richScope = { ...scope, locationId: "legacy" };
    const richCallId = randomUUID();
    const rich = await new PostgresLedger(db, undefined, undefined, "unsafeReference")
      .start(richCallId, referenceDefaultPolicy(richScope));
    assert.equal(rich.ok, true);
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${richScope.tenantId}, ${richScope.clinicId}, ${richScope.locationId}, 0,
        ${JSON.stringify({ scope: richScope, policyVersion: "0", bookingEnabled: false, privateText })}::jsonb)`.execute(db);
    await sql`insert into effect_outbox (effect_id, call_id, tenant_id, kind, status, payload)
      values (${randomUUID()}, ${richCallId}, ${richScope.tenantId}, 'hostWrite', 'pending',
        ${JSON.stringify({ privateText })}::jsonb)`.execute(db);
    const blocked = await checkStandaloneTextDatabase(db);
    assert.deepEqual(blocked, { ok: false, error: { kind: "unsafeExistingData",
      areas: ["calls", "effectOutbox", "settings"] } });
    assert.equal(JSON.stringify(blocked).includes(privateText), false);

    const child = spawnSync(process.execPath, ["scripts/ask-cliniko-availability.ts"], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, DATABASE_URL: target.toString(), ABBY_TENANT_ID: scope.tenantId,
        ABBY_CLINIC_ID: scope.clinicId, ABBY_LOCATION_ID: scope.locationId,
        ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
        ABBY_CLINIKO_BUSINESS_ID: "11", ABBY_CLINIKO_PRACTITIONER_ID: "22",
        ABBY_CLINIKO_APPOINTMENT_TYPE_ID: "33" },
      input: JSON.stringify({ text: privateText, from: "2026-10-02", to: "2026-10-02" }),
      encoding: "utf8", timeout: 10_000, maxBuffer: 8_192,
    });
    assert.equal(child.status, 1);
    assert.deepEqual(JSON.parse(child.stdout), blocked);
    assert.equal(`${child.stdout}${child.stderr}`.includes(privateText), false);
  } finally {
    await db?.destroy();
    try {
      if (created) await sql.raw(`drop database "${name}"`).execute(admin);
    } finally { await admin.destroy(); }
  }
});
