import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import { err, ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

test("E2E-018 standalone signed calls use the automation toggle without durable call or patient work",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 40_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl);
    const name = `abby_automation_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${name}`;
    let created = false;
    let db: ReturnType<typeof connectPostgres> | undefined;
    const openedCalls: Array<{ disconnect: () => Promise<unknown> }> = [];
    try {
      await sql.raw(`create database "${name}"`).execute(admin);
      created = true;
      db = connectPostgres(target.toString());
      await migrate(db);
      const scope = { tenantId: "automation-standalone", clinicId: "clinic", locationId: "main" };
      const accountSid = `AC${"1".repeat(32)}`;
      const authToken = "synthetic-twilio-token";
      const number = "+6125550199";
      const callerPhone = "+6145550101";
      const webhookUrl = "https://calls.example.test/twilio/inbound";
      const streamUrl = "wss://calls.example.test/twilio/media/";
      const now = "2026-09-29T10:00:00.000Z";
      let ready = true;
      const readiness = async () => ready ? ok(true as const) :
        err({ kind: "readinessFailed" as const, missing: ["mediaTestCall"] as const });
      const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", readiness,
        false, "standaloneMinimal");
      const routingHost = new ReferenceNumberRoutingHost([
        { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
      ]);
      const ingress = new TwilioSignedIngress({ accountSid, authToken,
        publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" },
        bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });

      async function signedCall(index: number) {
        assert.ok(db);
        const callSid = `CA${String(index).padStart(32, "0")}`;
        const streamSid = `MZ${String(index).padStart(32, "0")}`;
        const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: callerPhone };
        const webhook = ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound",
          contentType: "application/x-www-form-urlencoded",
          signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
          body: new URLSearchParams(form).toString() });
        assert.ok(webhook.ok);
        const binding = webhook.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
        assert.ok(binding);
        const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
        const start = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
          start: { accountSid, callSid, streamSid, tracks: ["inbound"],
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
            customParameters: { abbyBinding: binding } } });
        const authenticated = ingress.authenticateStream({ method: "GET", requestTarget: "/twilio/media/",
          signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start });
        assert.ok(authenticated.ok);
        const sent: Record<string, unknown>[] = [];
        const spoken: string[] = [];
        const composed = await createStandaloneTransientVoiceCall({ db, routingHost,
          stream: authenticated.value, readiness, now: () => now,
          send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued" as const; },
          transcriptionFactory: sessionId => ({
            async accept() { return ok([]); },
            async flush(generation) { return ok([{ kind: "segmentFinal", sessionId,
              generation, utteranceId: "request", text: "Please speak with staff", quality: "clear" }]); },
          }),
          synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
          resolveIntent: async () => ok({ kind: "handoff", reason: "callerRequested" }),
          mediaOptions: { silenceMs: 100 },
        });
        assert.ok(composed.ok);
        const call = composed.value;
        openedCalls.push(call);
        assert.deepEqual(await call.receive(connected), { ok: true, value: { kind: "connected" } });
        return { call, start, streamSid, callSid, sent, spoken };
      }

      const defaultOff = await signedCall(1);
      assert.deepEqual(await defaultOff.call.receive(defaultOff.start),
        { ok: false, error: { kind: "automationDisabled" } });
      assert.deepEqual(defaultOff.sent, []);
      assert.deepEqual(defaultOff.spoken, []);

      const enabled = await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin");
      assert.ok(enabled.ok);
      assert.equal(enabled.value.automationVersion, "1");
      const active = await signedCall(2);
      const started = await active.call.receive(active.start);
      assert.ok(started.ok);
      assert.deepEqual(active.sent.map(message => message.event), ["media", "mark"]);
      assert.deepEqual(active.spoken, ["Hello. How can I help you?"]);

      const invalid = await policy.changeAutomationEnabled(scope, "1", "false" as unknown as boolean, "clinic-admin");
      assert.deepEqual(invalid, { ok: false, error: { kind: "invalidValue" } });
      const afterInvalid = await policy.read(scope);
      assert.ok(afterInvalid.ok);
      assert.equal(afterInvalid.value.automationVersion, "1");
      assert.equal(afterInvalid.value.capabilities.transfer, "unavailable");
      const disabled = await policy.changeAutomationEnabled(scope, "1", false, "clinic-admin");
      assert.ok(disabled.ok);
      assert.equal(disabled.value.automationVersion, "2");
      const played = await active.call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2",
        streamSid: active.streamSid, mark: { name: (active.sent[1]?.mark as { name: string }).name } }));
      assert.ok(played.ok);
      for (let frame = 0; frame < 7; frame += 1) {
        const progressed = await active.call.receive(JSON.stringify({ event: "media",
          sequenceNumber: String(frame + 3), streamSid: active.streamSid,
          media: { track: "inbound", chunk: String(frame + 1), timestamp: String(frame * 20),
            payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
        assert.ok(progressed.ok);
      }
      assert.deepEqual(active.spoken, ["Hello. How can I help you?",
        "I can't send a staff request from this call. Please contact the clinic directly."]);
      assert.ok((await active.call.receive(JSON.stringify({ event: "stop", sequenceNumber: "10",
        streamSid: active.streamSid, stop: { accountSid, callSid: active.callSid } }))).ok);

      const newOff = await signedCall(3);
      assert.deepEqual(await newOff.call.receive(newOff.start),
        { ok: false, error: { kind: "automationDisabled" } });
      assert.deepEqual(newOff.sent, []);
      assert.deepEqual(newOff.spoken, []);

      assert.ok((await policy.changeAutomationEnabled(scope, "2", true, "clinic-admin")).ok);
      ready = false;
      const notReady = await signedCall(4);
      assert.deepEqual(await notReady.call.receive(notReady.start),
        { ok: false, error: { kind: "readinessFailed" } });
      assert.deepEqual(notReady.sent, []);
      assert.deepEqual(notReady.spoken, []);

      const counts = await sql<{ calls: number; events: number; effects: number; staff: number }>`
        select (select count(*)::int from calls) as calls,
               (select count(*)::int from call_events) as events,
               (select count(*)::int from effect_outbox) as effects,
               (select count(*)::int from staff_items) as staff`.execute(db);
      assert.deepEqual(counts.rows[0], { calls: 0, events: 0, effects: 0, staff: 0 });
      const canaries = [{ label: "caller_phone", value: callerPhone },
        { label: "provider_call", value: active.callSid },
        { label: "caller_request", value: "Please speak with staff" }];
      assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    } finally {
      await Promise.allSettled(openedCalls.map(call => call.disconnect()));
      await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
