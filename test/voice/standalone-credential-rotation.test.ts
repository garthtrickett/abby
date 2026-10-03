import { seedSyntheticVoicePreferences } from "../support/seed-synthetic-voice-preferences.ts";
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
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneClinikoAdminDashboard } from "../../src/standalone/cliniko-admin-dashboard.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { seedSyntheticCatalogueApproval } from "../support/seed-synthetic-catalogue-approval.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const root = new URL("../../", import.meta.url);
const scope = { tenantId: "rotation-test", clinicId: "clinic", locationId: "main" };
const number = "+6125550199";
const caller = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const route = { accountRef: accountSid, dialedNumber: number, routeVersion: "rotation-v1" };
const originalKey = "synthetic-key-au5";
const rotatedKey = "synthetic-rotated-key-au5";

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
  const until = Date.now() + 12_000;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(check(), `${label} timed out`);
}

test("E2E-215 rotated Cliniko credential blocks signed calls until a clinic admin reapproves the route",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl);
    const databaseName = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    const voicePort = await freePort();
    const adminPort = await freePort();
    const adminOrigin = `http://127.0.0.1:${adminPort}`;
    const callIds: string[] = [];
    const methods: string[] = [];
    const speech: string[] = [];
    let output = "";
    let child: ReturnType<typeof spawn> | undefined;
    let socket: WebSocket | undefined;
    let adminServer: Server | undefined;
    let adminDb: ReturnType<typeof connectPostgres> | undefined;
    let created = false;
    const envBase: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_VOICE_TEST_MODE: "1",
      ABBY_VOICE_PORT: String(voicePort), ABBY_TWILIO_TEST_CALLER_NUMBER: caller,
      ABBY_TENANT_ID: scope.tenantId, ABBY_CLINIC_ID: scope.clinicId, ABBY_LOCATION_ID: scope.locationId,
      ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com", ABBY_TWILIO_TEST_NUMBER: number,
      ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188", ABBY_TWILIO_ACCOUNT_SID: accountSid,
      ABBY_TWILIO_AUTH_TOKEN: authToken, ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl,
      ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl, ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32),
      ABBY_VOICE_ROUTE_VERSION: route.routeVersion, ABBY_GREETING_VERSION: "rotation-v1",
      ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-owner",
      ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
      ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0", ABBY_OPENAI_API_KEY: "synthetic-openai",
      ABBY_OPENAI_INTENT_MODEL: "synthetic-model" };
    const start = async (key: string) => {
      child = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"], {
        cwd: root, env: { ...envBase, ABBY_CLINIKO_API_KEY: key }, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.stdout?.on("data", data => { output += String(data); });
      child.stderr?.on("data", data => { output += String(data); });
      child.on("message", message => {
        if (typeof message !== "object" || message === null || !("kind" in message)) return;
        if (message.kind === "clinikoMethod" && "method" in message && typeof message.method === "string") {
          methods.push(message.method);
        }
        if (message.kind === "speech" && "text" in message && typeof message.text === "string") speech.push(message.text);
      });
      let healthy = false;
      const until = Date.now() + 15_000;
      while (!healthy && Date.now() < until) {
        try { healthy = (await fetch(`http://127.0.0.1:${voicePort}/healthz`,
          { signal: AbortSignal.timeout(500) })).status === 200; }
        catch { await new Promise(resolve => setTimeout(resolve, 40)); }
      }
      assert.ok(healthy, "synthetic voice runner did not start");
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      child = undefined;
    };
    const webhook = async (): Promise<Response> => {
      const callSid = `CA${randomUUID().replaceAll("-", "")}`;
      callIds.push(callSid);
      const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: caller };
      const response = await fetch(`http://127.0.0.1:${voicePort}/twilio/inbound`, { method: "POST", headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      }, body: new URLSearchParams(form) });
      return response;
    };
    const provisionalCall = async () => {
      const speechBefore = speech.length;
      const accepted = await webhook();
      assert.equal(accepted.status, 200);
      const binding = (await accepted.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
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
        start: { accountSid, callSid: callIds.at(-1), streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      await waitFor(() => messages.length >= 2, "greeting playback");
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
        mark: { name: (messages[1]!.mark as { name: string }).name } }));
      socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid,
        dtmf: { track: "inbound_track", digit: "2" } }));
      await waitFor(() => messages.length >= 4 && speech.length >= speechBefore + 2, "provisional availability");
      assert.match(speech.at(-1)!, /possible times/);
      assert.match(speech.at(-1)!, /can't reserve or confirm/);
      const closed = once(socket, "close");
      socket.close();
      await closed;
      socket = undefined;
    };
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin);
      created = true;
      const setupDb = connectPostgres(target.toString());
      try {
        await migrate(setupDb);
        await seedSyntheticVoicePreferences(setupDb, { tenantId: scope.tenantId, clinicId: scope.clinicId });
        await seedSyntheticCatalogueApproval(setupDb, { scope, ...route, apiKey: originalKey });
        const policy = new PostgresPolicyStore(setupDb, referenceDefaultPolicy, "unavailable",
          async () => ok(true), false, "standaloneMinimal");
        assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "synthetic-operator")).ok);
      } finally { await setupDb.destroy(); }

      await start(originalKey);
      await provisionalCall();
      await stop();
      const beforeRotation = methods.length;
      assert.ok(beforeRotation > 0 && methods.every(method => method === "GET"));
      await start(rotatedKey);
      const denied = await webhook();
      assert.equal(denied.status, 503);
      assert.doesNotMatch(await denied.text(), /<Stream/);
      assert.equal(methods.length, beforeRotation, "stale approval must not read Cliniko");

      const provider: typeof fetch = async (input, init) => {
        assert.equal(init?.method, "GET");
        const path = new URL(String(input)).pathname;
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
      adminDb = connectPostgres(target.toString());
      const prepared = await createStandaloneClinikoAdminDashboard({ db: adminDb, scope, route,
        apiKey: rotatedKey, contactEmail: "test@example.com", publicOrigin: adminOrigin,
        resolveActor: request => request.headers.cookie === "hostSession=rotation-owner"
          ? { actorRef: "rotation-owner", role: "clinicAdmin", scope } : null,
        bundlePath: new URL("../../dist/dashboard/cliniko-admin.js", import.meta.url).pathname,
        fetch: provider });
      assert.ok(prepared.ok);
      adminServer = prepared.value;
      adminServer.listen(adminPort, "127.0.0.1");
      await once(adminServer, "listening");
      const reapproval = await fetch(`${adminOrigin}/api/clinic-availability/command`, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: adminOrigin, Cookie: "hostSession=rotation-owner",
      }, body: JSON.stringify({ kind: "clinic.availability.approval.change.v1", route,
        selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0" },
        expectedVersion: 1 }) });
      assert.equal(reapproval.status, 200);
      await provisionalCall();
      assert.ok(methods.length > beforeRotation && methods.every(method => method === "GET"));
      assert.equal([caller, originalKey, rotatedKey, ...callIds].some(value => output.includes(value)), false);
      const privacy = connectPostgres(target.toString());
      const canaries = [
        { label: "caller", value: caller }, { label: "old_key", value: originalKey },
        { label: "new_key", value: rotatedKey },
        { label: "appointment", value: "synthetic-only" },
        ...callIds.map((value, index) => ({ label: `call_${index}`, value })),
      ];
      try { assert.deepEqual(await scanPatientDataCanaries(privacy, canaries), { ok: true, value: [] }); }
      finally { await privacy.destroy(); }
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    } finally {
      socket?.terminate();
      if (adminServer) {
        adminServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => adminServer!.close(error => error ? reject(error) : resolve()));
      }
      await adminDb?.destroy();
      await stop();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
