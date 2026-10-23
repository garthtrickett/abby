// E2E-176: the actual compiled runner refuses unsupported shared-budget schema before listening.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { compiledRuntimeEntrypoint } from "../support/compiled-runtime-entrypoint.ts";
import { waitForVoiceListener } from "../support/child-voice-listener.ts";

function environment(connectionString: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS,
    DATABASE_URL: connectionString, ABBY_VOICE_PORT: "0", ABBY_ISOLATED_POSTGRES_PROBE: "1",
    ABBY_TENANT_ID: "schema-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.test",
    ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://calls.example.test/twilio/inbound",
    ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://calls.example.test/twilio/media/",
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "schema-test-v1",
    ABBY_GREETING_VERSION: "schema-test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow.",
    ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  };
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  child.kill("SIGTERM"); await exited;
}

for (const drift of ["missingBudgetTable", "incompatibleBudgetColumn"] as const)
test(`actual compiled standalone runner refuses required budget schema before listening: ${drift}`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
    assert.ok(process.env.DATABASE_URL);
    const admin = connectPostgres(process.env.DATABASE_URL), name = `abby_schema_runner_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(process.env.DATABASE_URL); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined, child: ChildProcess | undefined;
    const start = () => spawn(process.execPath, [compiledRuntimeEntrypoint("scripts/serve-cliniko-voice.ts")], {
      cwd: new URL("../../", import.meta.url), env: environment(target.toString()), stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      child = start(); assert.ok(await waitForVoiceListener(child)); await stop(child); assert.equal(child.exitCode, 0);
      if (drift === "missingBudgetTable") await sql`alter table cliniko_request_budgets rename to cliniko_request_budgets_unavailable`.execute(db);
      else await sql`alter table cliniko_request_budgets rename column sent_at_ms to legacy_sent_at_ms`.execute(db);
      assert.equal((await sql<{ ready: number }>`select 1 as ready`.execute(db)).rows[0]!.ready, 1);
      child = start(); const messages: unknown[] = []; let stdout = "", stderr = "";
      child.on("message", message => messages.push(message));
      child.stdout!.on("data", chunk => { stdout += String(chunk); }); child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 1); assert.equal(signal, null); assert.deepEqual(messages, []);
      assert.equal(stdout, ""); assert.equal(stderr, "voice service unavailable\n");
    } finally {
      try { await stop(child); } finally {
        await db?.destroy(); try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
        finally { await admin.destroy(); }
      }
    }
  });

for (const signal of ["SIGINT", "SIGTERM"] as const)
test(`actual compiled standalone runner owns shutdown before publishing listener readiness: ${signal}`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
    assert.ok(process.env.DATABASE_URL);
    const admin = connectPostgres(process.env.DATABASE_URL), name = `abby_schema_shutdown_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(process.env.DATABASE_URL); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined, child: ChildProcess | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      const hook = fileURLToPath(new URL("../support/shutdown-at-listener-ready.mjs", import.meta.url));
      child = spawn(process.execPath, ["--import", hook, compiledRuntimeEntrypoint("scripts/serve-cliniko-voice.ts")], {
        cwd: new URL("../../", import.meta.url),
        env: { ...environment(target.toString()), ABBY_SCHEMA_RUNNER_SHUTDOWN_SIGNAL: signal },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const messages: unknown[] = []; let stderr = "";
      child.on("message", message => messages.push(message));
      child.stdout!.resume(); child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const [code, terminatedBy] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 0); assert.equal(terminatedBy, null); assert.equal(stderr, "");
      assert.equal(messages.length, 1);
      assert.ok(typeof messages[0] === "object" && messages[0] !== null &&
        "kind" in messages[0] && messages[0].kind === "listenerReady");
    } finally {
      try { await stop(child); } finally {
        await db?.destroy(); try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
        finally { await admin.destroy(); }
      }
    }
  });
