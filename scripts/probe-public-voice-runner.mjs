import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { connectPostgres } from "../src/storage/connect.ts";
import { migrate } from "../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../test/storage/backup-canary-scan.ts";
import { seedSyntheticCatalogueApproval } from "../test/support/seed-synthetic-catalogue-approval.ts";
import { waitForVoiceListener } from "../test/support/child-voice-listener.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const number = "+6125550199";
const callerNumber = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = randomBytes(24).toString("hex");
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;

// The package command supplies a disposable local PostgreSQL container. Guard
// against an inherited remote URL even if the probe flag was set by mistake.
const adminUrl = process.env.DATABASE_URL;
let adminLocation;
try { adminLocation = new URL(adminUrl); } catch { /* invalid or absent */ }
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !adminUrl ||
    adminLocation?.hostname !== "127.0.0.1" || adminLocation.pathname !== "/postgres") {
  throw new Error("public runner probe requires scripts/with-postgres.sh");
}

async function deadline(promise, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function forwardingListener() {
  let targetPort = 0;
  const sockets = new Set();
  const server = createServer();
  server.on("connection", client => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    if (targetPort === 0) { client.destroy(); return; }
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    port,
    forwardTo(boundPort) { targetPort = boundPort; },
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timer;
  try {
    return await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("process shutdown timed out")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function publicUrl(tunnel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ngrok startup timed out")), 20_000);
    const lines = createInterface({ input: tunnel.stdout });
    lines.on("line", line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.msg === "started tunnel" && typeof record.url === "string" &&
          record.url.startsWith("https://")) {
        clearTimeout(timer);
        resolve(record.url);
      }
    });
    tunnel.once("exit", () => { clearTimeout(timer); reject(new Error("ngrok exited before startup")); });
    tunnel.once("error", () => { clearTimeout(timer); reject(new Error("ngrok failed to start")); });
  });
}

async function healthy(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("synthetic voice runner did not start");
}

async function transportPreflight(env) {
  let lastFailure = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The TCP forwarder runs in this process; a synchronous child would block
    // the event loop that must carry its public HTTPS and WSS probe traffic.
    const check = spawn(process.execPath, ["scripts/preflight-voice-public.ts", "--transport-only"],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    check.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-120); });
    let exitCode;
    try { [exitCode] = await deadline(once(check, "exit"), "public transport preflight", 15_000); }
    finally {
      if (check.exitCode === null && check.signalCode === null) check.kill("SIGTERM");
    }
    if (exitCode === 0) return;
    lastFailure = stderr.trim() || `exit ${exitCode ?? "unknown"}`;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`public HTTPS/WSS unsigned transport preflight failed: ${lastFailure}`);
}

async function webhook(url, from, sid, signed = true, signatureUrl = url) {
  const form = { AccountSid: accountSid, CallSid: sid, To: number, From: from };
  return fetch(url, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(signed ? { "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, signatureUrl, form) } : {}),
  }, body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000) });
}

function stream(url) {
  return new WebSocket(url, { handshakeTimeout: 10_000, headers: {
    "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, url, {}),
  } });
}

async function wrongStreamSignature(url) {
  return deadline(new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 10_000, headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, `${url}wrong`, {}),
    } });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on("open", () => { socket.terminate(); reject(new Error("incorrect WSS URL signature accepted")); });
    socket.on("error", () => { reject(new Error("incorrect WSS URL signature handshake failed")); });
  }), "incorrect WSS signature rejection");
}

async function runnerDownWebhook(url) {
  let response;
  try { response = await webhook(url, callerNumber, `CA${randomUUID().replaceAll("-", "")}`); }
  catch { return "network failure"; }
  assert.ok(response.status >= 500, `stopped runner returned HTTP ${response.status}`);
  assert.doesNotMatch(await response.text(), /<Stream\b/);
  return `HTTP ${response.status}`;
}

async function runnerDownStream(url) {
  return deadline(new Promise((resolve, reject) => {
    const socket = stream(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      if (response.statusCode >= 500) resolve(`HTTP ${response.statusCode}`);
      else reject(new Error(`stopped runner accepted WSS route with HTTP ${response.statusCode}`));
    });
    socket.once("error", () => resolve("network failure"));
    socket.once("close", () => resolve("closed before handshake"));
    socket.once("open", () => { socket.terminate(); reject(new Error("stopped runner accepted a WSS stream")); });
  }), "runner-down WSS refusal");
}

function start(socket, binding, sid) {
  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: sid,
    start: { accountSid, callSid, streamSid: sid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { abbyBinding: binding } } }));
}

async function main() {
  const admin = connectPostgres(adminUrl);
  const name = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const forwarder = await forwardingListener();
  let created = false;
  let tunnel;
  let runner;
  let caller;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    const db = connectPostgres(target.toString());
    try { await migrate(db); } finally { await db.destroy(); }

    tunnel = spawn("ngrok", ["http", String(forwarder.port), "--log=stdout", "--log-format=json"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const base = await publicUrl(tunnel);
    const host = new URL(base).host;
    const webhookUrl = `https://${host}/twilio/inbound`;
    const streamUrl = `wss://${host}/twilio/media/`;
    // Give the public-facing runner only synthetic settings. In particular, do
    // not pass through any real provider credentials from the operator's shell.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      DATABASE_URL: target.toString(),
      ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_VOICE_PORT: "0", ABBY_VOICE_TEST_MODE: "1",
      ABBY_TWILIO_TEST_CALLER_NUMBER: callerNumber,
      ABBY_TENANT_ID: "public-probe", ABBY_CLINIC_ID: "synthetic-clinic", ABBY_LOCATION_ID: "synthetic-location",
      ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
      ABBY_TWILIO_TEST_NUMBER: number, ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
      ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: authToken,
      ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl, ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl,
      ABBY_TWILIO_BINDING_KEY_HEX: randomBytes(32).toString("hex"), ABBY_VOICE_ROUTE_VERSION: "public-probe-v1",
      ABBY_TEST_OPERATOR_REF: "synthetic-operator", ABBY_AUTOMATION_EXPECTED_VERSION: "0",
      ABBY_GREETING_VERSION: "public-probe-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
      ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
      ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0",
      ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
    };
    const enable = spawnSync(process.execPath, ["scripts/set-voice-test-automation.ts", "enable"],
      { cwd: root, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(enable.status, 0, "synthetic test policy could not be enabled");
    const approvalDb = connectPostgres(target.toString());
    try { await seedSyntheticCatalogueApproval(approvalDb, {
      scope: { tenantId: "public-probe", clinicId: "synthetic-clinic", locationId: "synthetic-location" },
      accountRef: accountSid, dialedNumber: number, routeVersion: "public-probe-v1",
      apiKey: "synthetic-key-au5" }); }
    finally { await approvalDb.destroy(); }
    runner = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    runner.stdout.resume();
    runner.stderr.resume();
    const boundPort = await waitForVoiceListener(runner);
    forwarder.forwardTo(boundPort);
    await healthy(boundPort);
    await healthy(forwarder.port);
    assert.equal((await fetch(`http://127.0.0.1:${boundPort}/readyz`)).status, 503);
    await transportPreflight(env);
    process.stdout.write(`actual runner reachable at ${webhookUrl} and ${streamUrl}; unsigned traffic rejected\n`);

    assert.equal((await webhook(webhookUrl, callerNumber, callSid, false)).status, 403);
    assert.equal((await webhook(webhookUrl, callerNumber, callSid, true, `${webhookUrl}/`)).status, 403);
    assert.equal(await wrongStreamSignature(streamUrl), 403);
    const unlisted = await webhook(webhookUrl, "+6145550102", callSid);
    assert.equal(unlisted.status, 503);
    assert.doesNotMatch(await unlisted.text(), /<Stream>/);
    const accepted = await webhook(webhookUrl, callerNumber, callSid);
    assert.equal(accepted.status, 200);
    const xml = await accepted.text();
    assert.ok(xml.includes(`<Stream url="${streamUrl}">`), "TwiML must contain the exact public WSS URL");
    assert.ok(xml.endsWith("</Connect><Dial>+6125550188</Dial></Response>"));
    const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);

    const forged = stream(streamUrl);
    await deadline(once(forged, "open"), "forged stream open");
    const forgedClosed = once(forged, "close");
    start(forged, `${binding.startsWith("A") ? "B" : "A"}${binding.slice(1)}`, `MZ${"4".repeat(32)}`);
    assert.equal((await deadline(forgedClosed, "forged stream close"))[0], 1008);

    caller = stream(streamUrl);
    await deadline(once(caller, "open"), "caller stream open");
    const received = [];
    caller.on("message", data => received.push(JSON.parse(data.toString())));
    async function waitFor(count) {
      const deadline = Date.now() + 15_000;
      while (received.length < count && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(received.length >= count, `voice output ${count} timed out`);
    }
    start(caller, binding, streamSid);
    await waitFor(2);
    assert.deepEqual(received.slice(0, 2).map(item => item.event), ["media", "mark"]);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: received[1].mark.name } }));
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid,
      dtmf: { track: "inbound_track", digit: "1" } }));
    await waitFor(4);
    assert.deepEqual(received.slice(2, 4).map(item => item.event), ["media", "mark"]);
    for (let index = 0; index < 2; index += 1) caller.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 4), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, 0x9f).toString("base64") } }));
    await waitFor(6);
    assert.deepEqual(received.slice(4, 6).map(item => item.event), ["mark", "clear"]);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "6", streamSid,
      mark: { name: received[3].mark.name } }));
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "7", streamSid,
      mark: { name: received[4].mark.name } }));
    const closed = once(caller, "close");
    assert.equal((await stop(runner))?.[0], 0, "synthetic voice runner did not drain cleanly");
    runner = undefined;
    await deadline(closed, "caller stream close");
    caller = undefined;
    process.stdout.write("signed call admitted; greeting, keypad availability, interruption and disconnect observed\n");

    const [webhookFailure, streamFailure] = await Promise.all([
      runnerDownWebhook(webhookUrl), runnerDownStream(streamUrl),
    ]);
    process.stdout.write(`stopped runner refused new public ingress: HTTPS ${webhookFailure}; WSS ${streamFailure}\n`);

    const privateDb = connectPostgres(target.toString());
    try {
      assert.deepEqual(await scanPatientDataCanaries(privateDb, [
        { label: "caller", value: callerNumber }, { label: "provider_call", value: callSid },
        { label: "appointment", value: "synthetic-only" },
      ]), { ok: true, value: [] });
    } finally { await privateDb.destroy(); }
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
      { label: "caller", value: callerNumber }, { label: "provider_call", value: callSid },
      { label: "appointment", value: "synthetic-only" },
    ]), []);
    process.stdout.write("isolated database and backup canary scans clear\n");
  } finally {
    caller?.terminate();
    try { await stop(runner); } catch { runner?.kill("SIGKILL"); }
    try { await stop(tunnel); } catch { tunnel?.kill("SIGKILL"); }
    await forwarder.close();
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
}

try { await main(); }
catch (error) {
  process.stderr.write(`public runner probe failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
