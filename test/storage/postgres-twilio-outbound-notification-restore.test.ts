import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { assertNotificationPrivacy } from "../support/outbound-notification-privacy.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL || process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1") throw Error("isolated disposable PostgreSQL required");
const sourceUrl = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(sourceUrl.hostname)) throw Error("local disposable PostgreSQL required");
const db = connectPostgres(sourceUrl.toString()); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { twilioNotificationRecoveryFixture } = await import(new URL("test/support/twilio-outbound-notification-recovery.js", emitted).href) as typeof import("../support/twilio-outbound-notification-recovery.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { TwilioOutboundTerminalObservationProducer } = await import(new URL("src/standalone/twilio-outbound-terminal-observation.js", emitted).href) as typeof import("../../src/standalone/twilio-outbound-terminal-observation.ts");

test("actual logical backup restore preserves the permanent signed-notification purpose before any duplicate native POST", { timeout: 60000 }, async () => {
  const request = outboundRequestValue(), scope = { ...request.scope, tenantId: `notification-restore-${randomUUID()}` },
    patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-outbound-au5", maxPerMinute: 180 });
  const f = await twilioNotificationRecoveryFixture({ request: { ...request, scope, patientId }, budget, effectsFactory: (s, owner) => new PostgresOutboundEffectBarrier(db, s, owner) });
  const nativeBefore = structuredClone([...f.native.rows]), source = (await sql`select * from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.equal(source.length, 1);
  const dump = execFileSync("pg_dump", [sourceUrl.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 });
  const name = `notification_restore_${randomUUID().replaceAll("-", "")}`;
  await sql.raw(`create database "${name}"`).execute(db);
  const restoredUrl = new URL(sourceUrl); restoredUrl.pathname = `/${name}`; const restored = connectPostgres(restoredUrl.toString());
  try {
    execFileSync("psql", [restoredUrl.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10000, maxBuffer: 8000000 });
    const observations = { ...f.observations, rateBudget: new PostgresClinikoRequestBudget(restored, { apiKey: f.observations.apiKey, maxPerMinute: 180 }) };
    const fresh = value(TwilioOutboundTerminalObservationProducer.create({ runtime: f.runtime, observations, key: f.key }, { ...f.ports,
      effects: (s, owner) => new PostgresOutboundEffectBarrier(restored, s, owner) }));
    assert.equal((await fresh.observeStatus(f.request(), new AbortController().signal)).ok, false);
    assert.deepEqual((await sql`select * from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(restored)).rows, source);
    assert.deepEqual([...f.native.rows], nativeBefore); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1); assert.equal(f.carrierRequests, 1);
    await assertNotificationPrivacy(db, f, sourceUrl.toString()); await assertNotificationPrivacy(restored, f, restoredUrl.toString());
  } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
});
