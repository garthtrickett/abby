import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { signWebhook } from "../support/financial-webhook-handoff.ts";
import { now } from "../support/financial-retention.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

type Mode = "active" | "foreignScope" | "foreignBudget" | "invalid" | "alreadyStarted";
type Message = { kind: string; port?: number; reason?: string; aborted?: boolean; closed?: boolean; closeCalls?: number;
  creationAcknowledged?: number; messageAccepted?: number; sessions?: number; messages?: number };
const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 40_000 };
async function exitWithin(terminal: Promise<unknown[]>): Promise<unknown[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([terminal, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("financial runner terminal deadline")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function runner(mode: Mode, run: (context: { child: ReturnType<typeof fork>; messages: Message[];
  terminal: Promise<unknown[]>; output: string[]; db: ReturnType<typeof connectPostgres> }) => Promise<void>) {
  await withDisposablePostgres(async (admin, connectionString) => {
    const name = `abby_test_financial_runner_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(admin);
    const target = new URL(connectionString); target.pathname = `/${name}`;
    const db = connectPostgres(target.toString()), folder = await mkdtemp(join(tmpdir(), "abby-financial-runner-"));
    let child: ReturnType<typeof fork> | undefined, terminal: Promise<unknown[]> | undefined;
    try {
      await migrate(db);
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ABBY_")));
      Object.assign(env, { DATABASE_URL: target.toString(), NODE_OPTIONS: "--max-old-space-size=256",
        ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_SYNTHETIC_FINANCIAL_RUNNER: mode, ABBY_VOICE_PORT: "0",
        ABBY_TENANT_ID: "financial-runner-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
        ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "clinic@example.invalid",
        ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
        ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
        ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://calls.example.test/twilio/inbound",
        ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://calls.example.test/twilio/media/",
        ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "financial-test-v1",
        ABBY_GREETING_VERSION: "test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-owner",
        ABBY_GREETING_APPROVED_TEXT: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow.",
        ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0", ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model" });
      child = fork(new URL("../../dist/runtime/test/support/start-synthetic-financial-voice-runner.js", import.meta.url), [], {
        cwd: folder, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      terminal = once(child, "exit"); const messages: Message[] = [], output: string[] = [];
      child.on("message", raw => { if (raw && typeof raw === "object" && "kind" in raw) messages.push(raw as Message); });
      child.stdout?.on("data", bytes => output.push(String(bytes))); child.stderr?.on("data", bytes => output.push(String(bytes)));
      await run({ child, terminal, messages, output, db });
      assert.deepEqual(await readdir(folder), []);
      for (const secret of ["private-retention@example.invalid", "private-consumer", "cs_test_owner", "cliniko:recall:"])
        assert.equal(output.join("").includes(secret), false, "private financial context never enters runner output");
      assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "recipient", value: "private-retention@example.invalid" },
        { label: "checkout", value: "cs_test_owner" }, { label: "native", value: "Abby financial intent v1" }]), { ok: true, value: [] });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await terminal; }
      await db.destroy(); await sql.raw(`drop database "${name}"`).execute(admin); await rm(folder, { recursive: true, force: true });
    }
  });
}

test("compiled owning runner starts independent finance, authenticates raw events and closes both owners", options, async () => {
  await runner("active", async ({ child, messages, terminal }) => {
    await voiceUntil(() => messages.some(m => m.kind === "listenerReady") || child.exitCode !== null, "financial runner listener");
    const port = messages.find(m => m.kind === "listenerReady")?.port; assert.ok(port);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/readyz`)).status, 503, "financial provisioning grants no call readiness");
    assert.equal((await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "bad" }, body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/stripe/webhook?alternate=1`, { method: "POST", body: "{}" })).status, 403);
    await voiceUntil(() => messages.some(m => m.kind === "cycle" && m.creationAcknowledged === 1), "one actual owning-runner Checkout", 10_000);
    await voiceUntil(() => messages.some(m => m.kind === "cycle" && m.messageAccepted === 1 && m.messages === 1), "independent original link delivery", 10_000);
    const signed = signWebhook(JSON.stringify({ id: "evt_runner", object: "event", type: "checkout.session.completed",
      created: Date.parse(now) / 1_000, account: "acct_fixture", livemode: false, api_version: "2025-06-30.basil",
      data: { object: { object: "checkout.session", id: "cs_test_owner", payment_status: "paid" } } }));
    const event = await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signed.signature }, body: signed.raw });
    assert.equal(event.status, 200); assert.equal(await event.text(), '{"ok":true}');
    child.send({ kind: "paid" }); await voiceUntil(() => messages.some(m => m.kind === "paidApplied"), "independent current-money change");
    await voiceUntil(() => messages.some(m => m.kind === "cycle" && m.messageAccepted === 1 && m.messages === 2), "current-money receipt", 10_000);
    child.send({ kind: "denyRun" }); await voiceUntil(() => messages.some(m => m.kind === "runDenied"), "independent run withdrawal");
    const refused = await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signed.signature }, body: signed.raw });
    assert.equal(refused.status, 503); assert.equal(await refused.text(), '{"ok":false}');
    assert.ok(messages.filter(m => m.kind === "cycle").every(m => m.sessions === 1));
    child.kill("SIGTERM"); assert.deepEqual(await exitWithin(terminal), [0, null]);
    assert.ok(messages.some(m => m.kind === "stopped" && m.aborted === true && m.closed === true));
    await assert.rejects(fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_000) }));
  });
});
for (const mode of ["foreignScope", "foreignBudget", "invalid", "alreadyStarted"] as const)
  test(`compiled financial runner refuses ${mode} before starting money or a listener`, options, async () => {
    await runner(mode, async ({ messages, terminal }) => {
      assert.deepEqual(await exitWithin(terminal), [1, null]);
      assert.deepEqual(messages.filter(m => m.kind === "refused"), [{ kind: "refused", reason: mode === "invalid" ? "invalidConsumer" : mode === "alreadyStarted" ? "startRejected" : "accountMismatch", closeCalls: 0, sessions: 0, messages: 0 }]);
      assert.equal(messages.some(m => m.kind === "listenerReady"), false);
      // A consumer started by another owner may already report zero-money cycles.
      // Rejection must neither start our listener nor close that existing owner.
      assert.ok(messages.filter(m => m.kind === "cycle").every(m =>
        mode === "alreadyStarted" && m.sessions === 0 && m.messages === 0));
    });
  });


test("compiled financial shutdown retires an unfinished raw webhook before closing the listener", options, async () => {
  await runner("active", async ({ child, messages, terminal }) => {
    await voiceUntil(() => messages.some(m => m.kind === "listenerReady") || child.exitCode !== null, "financial shutdown listener");
    const port = messages.find(m => m.kind === "listenerReady")?.port; assert.ok(port);
    const signed = signWebhook("{}");
    const request = httpRequest({ host: "127.0.0.1", port, path: "/stripe/webhook", method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed.signature,
        "content-length": Buffer.byteLength(signed.raw), expect: "100-continue" } });
    const reply = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      request.once("error", reject);
      request.once("response", response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    void reply.catch(() => undefined); // Cleanup may retire the client before an assertion awaits it.
    const continued = once(request, "continue"); request.flushHeaders();
    try {
      await continued; request.write("{");
      await new Promise<void>(resolve => setTimeout(resolve, 40));
      child.kill("SIGTERM");
      const [exit, response] = await Promise.all([exitWithin(terminal), reply]);
      assert.deepEqual(exit, [0, null]); assert.deepEqual(response, { status: 503, body: '{"ok":false}' });
      assert.ok(messages.some(m => m.kind === "stopped" && m.aborted === true && m.closed === true));
    } finally { request.destroy(); }
  });
});
