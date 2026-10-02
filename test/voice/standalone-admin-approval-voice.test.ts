import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { sql } from "kysely";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { createStandaloneClinikoAdminDashboard } from "../../src/standalone/cliniko-admin-dashboard.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { ok } from "../../src/core/model.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const root = new URL("../../", import.meta.url);
const scope = { tenantId: "admin-voice", clinicId: "clinic", locationId: "main" };
const number = "+6125550199";
const caller = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const route = { accountRef: accountSid, dialedNumber: number, routeVersion: "admin-voice-v1" };

async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  probe.close();
  await once(probe, "close");
  return address.port;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(check(), `${label} timed out`);
}

test("E2E-212 E2E-246 durable admin settings pin a signed call and revocation blocks the next call",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl);
    const databaseName = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    const sessionToken = randomUUID();
    const actor = { actorRef: "clinic-owner-212", role: "clinicAdmin" as const, scope };
    const providerPaths: string[] = [];
    const provider: typeof fetch = async (input, init) => {
      assert.equal(init?.method, "GET");
      const path = new URL(String(input)).pathname;
      providerPaths.push(path);
      if (path === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
        show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] });
      if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Practitioner",
        active: true, show_in_online_bookings: true });
      if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
        show_in_online_bookings: true });
      if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
        practitioners: [{ id: "22" }] });
      if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
        appointment_types: [{ id: "33" }] });
      throw new Error("unexpected synthetic catalogue request");
    };
    let created = false;
    let child: ReturnType<typeof spawn> | undefined;
    let socket: WebSocket | undefined;
    let activeAdmin: ReturnType<typeof connectPostgres> | undefined;
    let activeServer: Server | undefined;
    let runnerOutput = "";
    const methods: string[] = [];
    const speech: string[] = [];
    const adminRequest = async (origin: string, command: object): Promise<Response> =>
      fetch(`${origin}/api/clinic-availability/command`, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin, Cookie: `hostSession=${sessionToken}` },
        body: JSON.stringify(command) });
    const greetingRequest = async (origin: string, command: object): Promise<Response> =>
      fetch(`${origin}/api/settings/greeting`, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin, Cookie: `hostSession=${sessionToken}` },
        body: JSON.stringify(command) });
    const approvedGreetingText = "Welcome from this clinic's approved greeting. Press 1 for possible times today. Press 2 for possible times tomorrow.";
    const openAdmin = async () => {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      activeAdmin = connectPostgres(target.toString());
      const prepared = await createStandaloneClinikoAdminDashboard({ db: activeAdmin, scope, route,
        apiKey: "synthetic-key-au5", contactEmail: "test@example.com", publicOrigin: origin,
        resolveActor: request => request.headers.cookie === `hostSession=${sessionToken}` ? actor : null,
        bundlePath: new URL("../../src/standalone/dashboard/main.ts", import.meta.url).pathname,
        fetch: provider, now: () => new Date().toISOString() });
      assert.ok(prepared.ok);
      activeServer = prepared.value;
      activeServer.listen(port, "127.0.0.1");
      await once(activeServer, "listening");
      return origin;
    };
    const closeAdmin = async () => {
      const server = activeServer;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        activeServer = undefined;
      }
      await activeAdmin?.destroy();
      activeAdmin = undefined;
    };
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin);
      created = true;
      const setupDb = connectPostgres(target.toString());
      try {
        await migrate(setupDb);
        const policy = new PostgresPolicyStore(setupDb, referenceDefaultPolicy, "unavailable",
          async () => ok(true), false, "standaloneMinimal");
        assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "synthetic-operator")).ok);
      } finally { await setupDb.destroy(); }

      const firstOrigin = await openAdmin();
      const anonymous = await fetch(`${firstOrigin}/api/clinic-availability/command`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: firstOrigin },
        body: JSON.stringify({ kind: "clinic.availability.approval.read.v1" }) });
      assert.equal(anonymous.status, 403);
      assert.deepEqual(providerPaths, []);
      assert.equal((await greetingRequest(firstOrigin, { kind: "settings.routing.greeting.change.v1",
        expectedVersion: "0", enabled: true, greetingVersion: "clinic-approved-v1",
        approvedText: approvedGreetingText, effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: "2027-09-01T00:00:00.000Z" })).status, 200);
      assert.equal((await adminRequest(firstOrigin, { kind: "clinic.availability.approval.change.v1",
        route, selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33",
          policyVersion: "1" }, expectedVersion: 0 })).status, 200);
      assert.ok(providerPaths.length >= 5);
      await closeAdmin();

      const voicePort = await freePort();
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
        DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1",
        ABBY_VOICE_PORT: String(voicePort), ABBY_VOICE_TEST_MODE: "1",
        ABBY_TWILIO_TEST_CALLER_NUMBER: caller,
        ABBY_TENANT_ID: scope.tenantId, ABBY_CLINIC_ID: scope.clinicId,
        ABBY_LOCATION_ID: scope.locationId, ABBY_CLINIKO_API_KEY: "synthetic-key-au5",
        ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com", ABBY_TWILIO_TEST_NUMBER: number,
        ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188", ABBY_TWILIO_ACCOUNT_SID: accountSid,
        ABBY_TWILIO_AUTH_TOKEN: authToken, ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl,
        ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl, ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32),
        ABBY_VOICE_ROUTE_VERSION: route.routeVersion, ABBY_GREETING_VERSION: "test-v1",
        ABBY_GREETING_APPROVAL_OWNER_REF: "clinic-owner-212",
        ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
        ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0", ABBY_OPENAI_API_KEY: "synthetic-openai",
        ABBY_OPENAI_INTENT_MODEL: "synthetic-model" };
      child = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"], { cwd: root,
        env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout?.on("data", data => { runnerOutput += String(data); });
      child.stderr?.on("data", data => { runnerOutput += String(data); });
      child.on("message", message => {
        if (typeof message !== "object" || message === null || !("kind" in message)) return;
        if (message.kind === "clinikoMethod" && "method" in message && typeof message.method === "string") {
          methods.push(message.method);
        }
        if (message.kind === "speech" && "text" in message && typeof message.text === "string") {
          speech.push(message.text);
        }
      });
      let healthy = false;
      const until = Date.now() + 15_000;
      while (!healthy && Date.now() < until) {
        try { healthy = (await fetch(`http://127.0.0.1:${voicePort}/healthz`,
          { signal: AbortSignal.timeout(500) })).status === 200; }
        catch { await new Promise(resolve => setTimeout(resolve, 40)); }
      }
      assert.ok(healthy, "synthetic voice runner did not start");
      const webhook = (callSid: string) => {
        const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: caller };
        return fetch(`http://127.0.0.1:${voicePort}/twilio/inbound`, { method: "POST", headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
        }, body: new URLSearchParams(form) });
      };
      const callSid = `CA${randomUUID().replaceAll("-", "")}`;
      const accepted = await webhook(callSid);
      assert.equal(accepted.status, 200);
      const xml = await accepted.text();
      const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
      assert.ok(binding);
      socket = new WebSocket(`ws://127.0.0.1:${voicePort}/twilio/media/`, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      await once(socket, "open");
      const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
      const messages: Record<string, unknown>[] = [];
      socket.on("message", data => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      await waitFor(() => messages.length >= 2, "approved greeting");
      assert.equal(speech[0], approvedGreetingText);
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
        mark: { name: (messages[1]!.mark as { name: string }).name } }));

      const secondOrigin = await openAdmin();
      const current = await adminRequest(secondOrigin, { kind: "clinic.availability.approval.read.v1" });
      assert.equal(current.status, 200);
      const state = await current.json() as { value: { state: { version: number; approval: unknown } } };
      assert.equal(state.value.state.version, 1);
      assert.ok(state.value.state.approval);
      assert.equal((await adminRequest(secondOrigin, { kind: "clinic.availability.approval.revoke.v1",
        expectedVersion: 0 })).status, 409);
      assert.equal((await adminRequest(secondOrigin, { kind: "clinic.availability.approval.revoke.v1",
        expectedVersion: 1 })).status, 200);
      await closeAdmin();
      const methodsBeforeKeypad = methods.length;
      socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid,
        dtmf: { track: "inbound_track", digit: "2" } }));
      await waitFor(() => messages.length >= 4 && speech.length >= 2, "approved availability");
      assert.match(speech[1]!, /possible times/);
      assert.match(speech[1]!, /can't reserve or confirm/);
      assert.ok(methods.length > methodsBeforeKeypad && methods.every(method => method === "GET"));
      const socketClosed = once(socket, "close");
      socket.close();
      await socketClosed;
      socket = undefined;
      const readCount = methods.length;
      const rejected = await webhook(`CA${randomUUID().replaceAll("-", "")}`);
      assert.equal(rejected.status, 503);
      assert.doesNotMatch(await rejected.text(), /<Stream/);
      assert.equal(methods.length, readCount);
      const thirdOrigin = await openAdmin();
      assert.equal((await greetingRequest(thirdOrigin, { kind: "settings.routing.greeting.change.v1",
        expectedVersion: "1", enabled: true, greetingVersion: "missing-keypad-v2",
        approvedText: "Welcome to the clinic. How can I help?",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: "2027-09-01T00:00:00.000Z" })).status, 200);
      assert.equal((await adminRequest(thirdOrigin, { kind: "clinic.availability.approval.change.v1",
        route, selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33",
          policyVersion: "2" }, expectedVersion: 2 })).status, 200);
      await closeAdmin();
      const refusedCallSid = `CA${randomUUID().replaceAll("-", "")}`;
      const missingInstructions = await webhook(refusedCallSid);
      assert.equal(missingInstructions.status, 200);
      const missingXml = await missingInstructions.text();
      const missingBinding = missingXml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
      assert.ok(missingBinding);
      socket = new WebSocket(`ws://127.0.0.1:${voicePort}/twilio/media/`, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      await once(socket, "open");
      const refusedMessages: Record<string, unknown>[] = [];
      socket.on("message", data => refusedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      const refusedStreamSid = `MZ${randomUUID().replaceAll("-", "")}`;
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: refusedStreamSid,
        start: { accountSid, callSid: refusedCallSid, streamSid: refusedStreamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: missingBinding } } }));
      await waitFor(() => socket?.readyState === WebSocket.CLOSED, "invalid stored greeting refusal");
      assert.equal(refusedMessages.some(message => message.event === "media"), false);
      socket = undefined;
      assert.equal(methods.length, readCount);
      assert.equal(runnerOutput.includes(caller) || runnerOutput.includes(callSid), false);
      const privacyDb = connectPostgres(target.toString());
      try { assert.deepEqual(await scanPatientDataCanaries(privacyDb, [
        { label: "caller", value: caller }, { label: "provider_call", value: callSid },
        { label: "appointment", value: "synthetic-only" }]), { ok: true, value: [] }); }
      finally { await privacyDb.destroy(); }
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
        { label: "caller", value: caller }, { label: "provider_call", value: callSid },
        { label: "appointment", value: "synthetic-only" }]), []);
    } finally {
      socket?.terminate();
      await closeAdmin();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
