import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import WebSocket from "ws";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoSelectionApproval } from "../../src/cliniko/catalogue-setup.ts";
import { PostgresActiveCallClaims } from "../../src/storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { ok } from "../../src/core/model.ts";
import type { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withApprovedSyntheticVoice, syntheticSpeech } from "../support/approved-voice.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-299 clinical host rejects changed approved scope, policy, provider selection, zone and credential", async () => {
  const f = await bookingCallFlowFixture();
  try {
    const greeting = { ...resultValue(await f.policies.read(f.scope)).greeting! };
    const config = { ...f.flowConfig, scope: { ...f.scope }, greeting, intent: () => async () => ok({ kind: "model" as const }) };
    const host = new ClinikoVoiceClinicalHost(config);
    const approval: ClinikoSelectionApproval = { scope: { ...f.scope }, route: { accountRef: "test", dialedNumber: f.inbound.dialedNumber, routeVersion: "test" },
      selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: config.policyVersion }, alternatives: [],
      businessTimeZone: "Australia/Sydney", credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
      catalogueObservedAt: f.inbound.receivedAt, approvedAt: f.inbound.receivedAt, approvedBy: "synthetic-admin", patientActionMode: "unavailable", patientRequestMode: "unavailable" };
    assert.equal(host.matches(approval), true);
    for (const changed of [
      { ...approval, scope: { ...approval.scope, locationId: "other" } },
      { ...approval, selection: { ...approval.selection, policyVersion: "changed" } },
      { ...approval, selection: { ...approval.selection, practitionerId: "44" } },
      { ...approval, selection: { ...approval.selection, businessId: "55" } },
      { ...approval, selection: { ...approval.selection, appointmentTypeId: "66" } },
      { ...approval, businessTimeZone: "Etc/UTC" },
      { ...approval, credentialFingerprint: "f".repeat(64) },
    ]) { assert.equal(host.matches(changed), false); assert.throws(() => host.workflow(changed), /binding mismatch/); }
    config.scope.locationId = "mutated"; greeting.approvedText = "mutated";
    assert.equal(host.matches(approval), true); assert.notEqual(host.greeting.approvedText, "mutated");
    const owner = host.workflow(approval).create({ receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      ledger: f.ledger, policies: f.policies, signal: f.flowConfig.signal, clock: f.flowConfig.clock!, privatePresentation: { play: async () => true } });
    owner.dispose(); assert.equal(f.mail.length, 0, "constructing a host does not verify a patient");
  } finally { await f.close(); }
});

test("E2E-299 standalone server runs an approved clinical booking through signed ingress, private OTP and played confirmation", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async (db, connectionString) => {
    const f = await bookingCallFlowFixture(); f.flow.dispose();
    const c = f.flowConfig, scope = f.scope, now = c.clock!;
    const accountSid = `AC${"4".repeat(32)}`, callSid = `CA${randomUUID().replaceAll("-", "")}`, streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
    const authToken = "synthetic-clinical-runner", webhookUrl = "https://clinical.example.test/twilio/inbound", streamUrl = "wss://clinical.example.test/twilio/media/";
    const bindingKey = Buffer.alloc(32, 0x48), budget = new PostgresClinikoRequestBudget(db, { apiKey: c.cliniko.apiKey });
    const policies = withApprovedSyntheticVoice(c.policies), spoken: string[] = [], input: string[] = [], writes: Record<string, unknown>[] = [];
    let flow: ClinikoCallFlow | undefined, after: Record<string, unknown> | undefined, sequence = 1, chunk = 0, utterance = 0, ordinaryFrames = 0;
    const provider: typeof fetch = async (url, init) => {
      const u = new URL(String(url)), method = init?.method ?? "GET";
      if (method === "POST" && u.pathname === "/v1/individual_appointments") {
        const body = JSON.parse(String(init?.body)); writes.push(body);
        after = { id: "91", ...body, ends_at: new Date(Date.parse(body.starts_at) + 1_800_000).toISOString(), cancelled_at: null, archived_at: null, deleted_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } },
          business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } }, practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/22" } },
          appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/33" } } };
        return Response.json(after, { status: 201 });
      }
      if (after && u.pathname === "/v1/individual_appointments/91") return Response.json(after);
      if (u.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
      return c.fetchPort!(url, init);
    };
    const greeting = resultValue(await policies.read(scope)).greeting!;
    const host = new ClinikoVoiceClinicalHost({ ...c, scope, greeting, policies, cliniko: { ...c.cliniko, rateBudget: budget }, fetchPort: provider,
      intent(owner) { flow = owner; return async turn => turn.text === "Start" ? ok({ kind: "workflow", operation: "book" }) :
        turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }) :
          turn.text === "Second" ? ok({ kind: "bookingChoice", choice: 2 }) : ok({ kind: "affirm" }); } });
    const approval: ClinikoSelectionApproval = { scope, route: { accountRef: accountSid, dialedNumber: f.inbound.dialedNumber, routeVersion: "clinical-test" },
      selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: c.policyVersion }, alternatives: [],
      businessTimeZone: c.cliniko.timeZone, credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), approvedBy: "synthetic-admin",
      catalogueObservedAt: now(), approvedAt: now(), patientActionMode: "unavailable", patientRequestMode: "unavailable" };
    const server = resultValue(await createStandaloneClinikoVoiceServer({ db, activeCallClaims: new PostgresActiveCallClaims(connectionString, bindingKey),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl, bindingKey, fallbackNumbers: { [f.inbound.dialedNumber]: "+6125550188" }, now: () => new Date(now()) },
      routes: [{ scope, dialedNumber: f.inbound.dialedNumber, routeVersion: "clinical-test", rateBudget: budget, clinicalHost: host,
        approval: { readApprovedRoute: async () => ok(approval) }, credentialFingerprint: approval.credentialFingerprint,
        availabilityForSelection: s => resultValue(ClinikoAvailabilityReader.create({ ...c.cliniko, ...s, scope, rateBudget: budget }, provider)),
        keypadAvailabilityGreeting: { ...greeting, approvedText: "Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey: "synthetic-openai", intentModel: "synthetic-model", fetch: async () => { throw new Error("no provider request expected"); } },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcriptionFactory: sessionId => ({
        async accept() { ordinaryFrames++; return ok([]); }, async flush(generation) { const text = input.shift(); assert.ok(text); return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `turn-${++utterance}`, text, quality: "clear" }]); } }) }),
      readiness: async () => ok(true), now, mediaOptions: { silenceMs: 100 } }));
    let socket: WebSocket | undefined;
    try {
      server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
      const form = { AccountSid: accountSid, CallSid: callSid, To: f.inbound.dialedNumber, From: f.inbound.presentedCallerNumber! };
      const response = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) }, body: new URLSearchParams(form) });
      assert.equal(response.status, 200); const xml = await response.text(); const binding = /<Parameter name="abbyBinding" value="([^"]+)"/.exec(xml)?.[1]; assert.ok(binding);
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: { "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}) } });
      const sent: { event: string; mark?: { name: string } }[] = [], ack = new Set<string>(); socket.on("message", data => sent.push(JSON.parse(data.toString()))); await once(socket, "open");
      const send = (data: object) => socket!.send(JSON.stringify({ ...data, streamSid, sequenceNumber: String(sequence++) }));
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      send({ event: "start", start: { accountSid, callSid, streamSid, tracks: ["inbound"], customParameters: { abbyBinding: binding }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
      const mark = async () => { await voiceUntil(() => sent.some(m => m.event === "mark" && m.mark && !ack.has(m.mark.name)), "new clinical playback mark");
        const m = sent.filter(m => m.event === "mark" && m.mark && !ack.has(m.mark.name)).at(-1)!.mark!; ack.add(m.name); send({ event: "mark", mark: m }); };
      const turn = async (text: string) => { input.push(text); const before = spoken.length;
        for (let i = 0; i < 7; i++) send({ event: "media", media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20), payload: Buffer.alloc(160, i < 2 ? 0x9f : 0xff).toString("base64") } });
        await voiceUntil(() => spoken.length > before, "clinical response", 20_000); };
      await mark(); await turn("Start"); await mark(); await voiceUntil(() => f.mail.length === 1, "private verification delivery");
      for (const digit of `${f.mail[0]!.code}#`) send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => flow !== undefined && !flow.verificationRequired, "private verification result");
      const beforeQuiet = ordinaryFrames;
      // Packets arriving while the private fence is draining must stay private,
      // even if their semantic handling happens later. Pace actual quiet media
      // before sending the next voiced request. Silent ordinary media itself
      // does not enter transcription, so it cannot be used as an adapter fence.
      for (let i = 0; i < 30; i++) {
        send({ event: "media", media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20), payload: Buffer.alloc(160, 0xff).toString("base64") } });
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      assert.equal(ordinaryFrames, beforeQuiet, "fresh silence is not a transcribed patient turn");
      await turn("Times"); assert.ok(ordinaryFrames > beforeQuiet); assert.match(spoken.at(-1)!, /option|Physiotherapy/i); await mark(); await turn("Second");
      assert.match(spoken.at(-1)!, /Physiotherapy.*Demo Practitioner.*30 minutes/); assert.equal(writes.length, 0); await mark(); await turn("Yes");
      assert.equal(writes.length, 1, JSON.stringify({ replies: spoken, operation: flow?.workflow, privateInput: flow?.verificationRequired }));
      assert.equal(spoken.at(-1), "Your booking is confirmed."); assert.ok(flow);
      for (const secret of [f.mail[0]!.code, ...verificationCanaries.slice(0, 2)]) assert.equal(JSON.stringify(spoken).includes(secret), false);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.slice(0, 2).map((value, i) => ({ label: `clinical_${i}`, value })))), []);
    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) { socket.terminate(); await once(socket, "close"); }
      server.close(); await once(server, "close"); await f.close();
    }
  });
});
