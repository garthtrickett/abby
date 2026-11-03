import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { ok } from "../../src/core/model.ts";
import type { RestrictedTargetConfig, RehearsalSpeech, RehearsalCallStatistics } from "../../src/testing/restricted-twilio-target.ts";

const { createRestrictedTwilioTarget } = await import(new URL(
  "../../dist/runtime/src/testing/restricted-twilio-target.js", import.meta.url).href) as
  typeof import("../../src/testing/restricted-twilio-target.ts");

const accountSid = "AC" + "a".repeat(32), firstSid = "CA" + "b".repeat(32), streamSid = "MZ" + "c".repeat(32);
function config(): RestrictedTargetConfig {
  const held = new Set<string>();
  return { testMode: true, number: "+15555550101", caller: "+15555550102", endAt: Date.now() + 60_000,
    ingress: { accountSid, authToken: "synthetic-token", bindingKey: Buffer.alloc(32, 7),
      publicWebhookUrl: "https://test.example/twilio/inbound", publicStreamUrl: "wss://test.example/twilio/media/",
      fallbackNumbers: { "+15555550101": "+15555550103" } },
    activeCallClaims: { async claim(account, call) {
      const key = account + call;
      if (held.has(key)) return undefined;
      held.add(key);
      return { lost: new Promise<void>(() => {}), release: async () => { held.delete(key); } };
    } },
  };
}
function providers(): RehearsalSpeech {
  return { transcription: () => ({ accept: async () => ok([]), flush: async () => ok([]) }),
    synthesis: { async *stream() { yield new Uint8Array(640); } } };
}
async function until(condition: () => boolean | undefined) {
  for (let attempt = 0; attempt < 500; attempt++) { if (condition()) return; await delay(10); }
  throw Error("Local rehearsal condition timed out");
}
async function fixture(t: TestContext, options = config(), speech = providers(),
  report: (stats: RehearsalCallStatistics) => void = () => {}) {
  const app = createRestrictedTwilioTarget(options, speech, report), sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.stop().catch(() => {}); });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function post(from = options.caller, valid = true, callSid = firstSid) {
    const fields = { AccountSid: accountSid, CallSid: callSid, To: options.number, From: from };
    return fetch(base + "/twilio/inbound", { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": valid ? getExpectedTwilioSignature(options.ingress.authToken,
        options.ingress.publicWebhookUrl, fields) : "bad" }, body: new URLSearchParams(fields) });
  }
  async function open(callSid = firstSid) {
    const response = await post(options.caller, true, callSid); assert.equal(response.status, 200);
    const xml = await response.text(), binding = xml.match(/name="abbyBinding" value="([^"]+)"/)?.[1];
    assert(binding);
    const socket = new WebSocket(base.replace("http:", "ws:") + "/twilio/media/", { headers: {
      "x-twilio-signature": getExpectedTwilioSignature(options.ingress.authToken, options.ingress.publicStreamUrl, {}) } });
    sockets.push(socket); await once(socket, "open");
    const closed = once(socket, "close");
    let sequence = 1, chunk = 0, clears = 0, packets = 0;
    const send = (event: Record<string, unknown>) => socket.send(JSON.stringify({ sequenceNumber: String(sequence++), streamSid, ...event }));
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString()) as { event: string; mark: { name: string } };
      if (event.event === "mark") setTimeout(() => { if (socket.readyState === WebSocket.OPEN) send({ event: "mark", mark: event.mark }); }, 10);
      if (event.event === "clear") clears++;
      if (event.event === "media") packets++;
    });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    send({ event: "start", start: { streamSid, accountSid, callSid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } });
    return { socket, closed, send, counts: () => ({ clears, packets }), audio(voiced: boolean) {
      chunk++; send({ event: "media", media: { track: "inbound", chunk: String(chunk), timestamp: String((chunk - 1) * 20),
        payload: Buffer.alloc(160, voiced ? 0 : 255).toString("base64") } });
    } };
  }
  return { app, base, post, open, options };
}

test("restricted target: invalid test grant, shared numbers, claims, callback and expiry refuse construction", () => {
  const base = config();
  const invalid: unknown[] = [{ ...base, testMode: false }, { ...base, caller: base.number },
    { ...base, caller: base.ingress.fallbackNumbers[base.number] }, { ...base, activeCallClaims: undefined },
    { ...base, endAt: Date.now() - 1 }, { ...base, endAt: Date.now() + 10_800_000 },
    { ...base, fallbackCallback: "http://callback.example/fallback-ringing/" + "a".repeat(32) },
    { ...base, fallbackCallback: "https://callback.example/fallback-ringing/" + "a".repeat(32) + "?extra=1" }];
  for (const bad of invalid) assert.throws(() => createRestrictedTwilioTarget(bad as RestrictedTargetConfig, providers()), RangeError);
});

test("restricted target: signed real wire preserves greeting, quiet burst, interruption, privacy, stop and keypad fallback",
  { timeout: 20_000 }, async t => {
  let phrase = "hello"; const spoken: string[] = [], stats: RehearsalCallStatistics[] = [];
  const f = await fixture(t, config(), {
    transcription: sessionId => ({ accept: async () => ok([]), flush: async generation => ok([
      { kind: "segmentFinal", sessionId, generation, utteranceId: String(generation), text: phrase, quality: "needsClarification" }]) }),
    synthesis: { async *stream(text, signal) { spoken.push(text);
      for (let i = 0; i < (text.includes("count slowly") ? 300 : 10); i++) {
        if (signal.aborted) return; await delay(2); yield new Uint8Array(640);
      }
    } },
  }, value => stats.push(value));
  assert.equal((await f.post(f.options.caller, false)).status, 403);
  assert.equal((await f.post("+15555550104")).status, 503);
  assert.equal((await fetch(f.base + "/readyz")).status, 503);
  const call = await f.open(); await until(() => stats.at(-1)?.played === 1);
  assert(call.counts().packets > 0);
  for (let i = 0; i < 48; i++) call.audio(false);
  async function turn(text: string) { phrase = text; call.audio(true); call.audio(true);
    for (let i = 0; i < 35; i++) { call.audio(false); await delay(1); } }
  await turn("hello"); await until(() => stats.at(-1)?.played === 2); assert(spoken.at(-1)?.startsWith("Hello."));
  await turn("count"); await until(() => spoken.at(-1)?.includes("count slowly"));
  await turn("blue"); await until(() => stats.at(-1)?.clearAcknowledged === 1 && spoken.at(-1)?.includes("word blue"));
  await until(() => stats.at(-1)?.played === 3); assert.equal(call.counts().clears, 1);
  await turn("private unique canary medical detail never repeat"); await until(() => stats.at(-1)?.played === 4);
  assert(!spoken.some(text => text.includes("canary"))); assert(!JSON.stringify(stats).includes("canary"));
  assert.equal((await f.post()).status, 503);
  call.send({ event: "stop", stop: { accountSid, callSid: firstSid } }); await until(() => f.app.state().active === 0);
  call.socket.close(); await call.closed;
  assert(stats.at(-1)?.stopped); assert(!stats.at(-1)?.failed);
  const second = await f.open("CA" + "d".repeat(32)); await until(() => stats.at(-1)?.session === 2 && stats.at(-1)?.started);
  const ended = once(second.socket, "close"); second.send({ event: "dtmf", dtmf: { track: "inbound", digit: "9" } });
  assert.equal((await ended)[0], 1008); await until(() => f.app.state().active === 0); assert(stats.at(-1)?.dtmfFallback);
});

test("restricted target: fixed callback decorates only authenticated fallback TwiML", async t => {
  const options = { ...config(), fallbackCallback: "https://callback.example/fallback-ringing/" + "e".repeat(32) };
  const f = await fixture(t, options);
  assert.equal((await f.post(options.caller, false)).status, 403);
  const response = await f.post(); assert.equal(response.status, 200);
  const xml = await response.text(); assert(xml.includes(`statusCallback="${options.fallbackCallback}"`));
  assert(xml.includes('statusCallbackEvent="initiated ringing answered completed"'));
  assert.equal(f.app.state().total, 0);
});

test("restricted target: expired window denies admission while general readiness stays closed", async t => {
  let time = Date.now(); const base = config();
  const options = { ...base, now: () => time, ingress: { ...base.ingress, now: () => new Date(time) } };
  const f = await fixture(t, options); time = options.endAt;
  assert.equal((await f.post()).status, 503); assert.equal(f.app.state().windowOpen, false);
  assert.equal((await fetch(f.base + "/readyz")).status, 503); assert.equal(f.app.state().total, 0);
});

test("restricted target: six distinct sessions exhaust the target window without resetting on disconnect", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) {
    const sid = "CA" + (index + 1).toString(16).padStart(32, "0"), call = await f.open(sid);
    await until(() => f.app.state().total === index + 1 && f.app.state().active === 1);
    call.send({ event: "stop", stop: { accountSid, callSid: sid } }); await until(() => f.app.state().active === 0);
    call.socket.close(); await call.closed;
  }
  assert.equal((await f.post(f.options.caller, true, "CA" + "f".repeat(32))).status, 503);
  assert.equal(f.app.state().total, 6);
});

test("restricted target: unavailable reporting cannot erase greeting or prevent call cleanup", async t => {
  const f = await fixture(t, config(), providers(), () => { throw Error("report unavailable"); });
  const call = await f.open(); await until(() => call.counts().packets > 0);
  call.send({ event: "stop", stop: { accountSid, callSid: firstSid } }); await until(() => f.app.state().active === 0);
  assert.equal(f.app.state().total, 1);
});

test("restricted target CLI: fresh private report, loopback startup, explicit mode and existing-report refusal",
  { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "abby-rehearsal-cli-")), report = join(directory, "report.json");
  const script = fileURLToPath(new URL("../../dist/runtime/scripts/serve-twilio-rehearsal.js", import.meta.url));
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", ABBY_VOICE_TEST_MODE: "1",
    ABBY_REHEARSAL_TARGET_PORT: "0", ABBY_TWILIO_ACCOUNT_SID: accountSid,
    ABBY_TWILIO_AUTH_TOKEN: "synthetic-token", ABBY_TWILIO_BINDING_KEY_HEX: "07".repeat(32),
    ABBY_TWILIO_TEST_NUMBER: "+15555550101", ABBY_TWILIO_TEST_CALLER_NUMBER: "+15555550102",
    ABBY_TWILIO_FALLBACK_NUMBER: "+15555550103", ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://test.example/twilio/inbound",
    ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://test.example/twilio/media/", DATABASE_URL: "postgresql://invalid.example/test",
    ABBY_DEEPGRAM_API_KEY: "synthetic-only", ABBY_OPENAI_API_KEY: "synthetic-only" };
  const child = spawn(process.execPath, ["--max-old-space-size=96", script, "--serve", report],
    { env: environment, stdio: "ignore" });
  const finished = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await finished;
    await rm(directory, { recursive: true, force: true }); });
  type CliReport = { phase: string; port: number; runId: string; clinicalAutomationEnabled: boolean };
  let ready: CliReport | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(child.exitCode, null, "CLI exited before its loopback listener was ready");
    try { const value = JSON.parse(await readFile(report, "utf8")) as CliReport;
      if (value?.phase === "listening") { ready = value; break; } } catch { /* initial report not yet installed */ }
    await delay(25);
  }
  assert(ready); assert.match(ready.runId, /^[a-f0-9]{32}$/); assert.equal(ready.clinicalAutomationEnabled, false);
  const base = `http://127.0.0.1:${ready.port}`;
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal((await fetch(base + "/readyz")).status, 503);
  child.kill("SIGTERM"); assert.deepEqual(await finished, [0, null]);
  const before = await readFile(report, "utf8"); assert.equal(JSON.parse(before).phase, "stopped");

  async function refusal(path: string, mode: string) {
    const denied = spawn(process.execPath, ["--max-old-space-size=96", script, "--serve", path],
      { env: { ...environment, ABBY_VOICE_TEST_MODE: mode }, stdio: "ignore", timeout: 5_000 });
    assert.deepEqual(await once(denied, "exit"), [1, null]);
  }
  await refusal(report, "1"); assert.equal(await readFile(report, "utf8"), before);
  const absent = join(directory, "disabled.json"); await refusal(absent, "0");
  await assert.rejects(readFile(absent), { code: "ENOENT" });
});
