import { syntheticSpeech } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import type { TransientVoiceConfig } from "../../src/standalone/transient-voice-composition.ts";
import { VerifiedAppointmentReadSession } from "../../src/standalone/verified-appointment-read-session.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import type { CallerCandidates } from "../../src/voice/caller-candidates.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const at = "2026-10-01T10:00:00.000Z";
const from = "2026-10-01T10:00:00.000Z";
const to = "2026-10-05T10:00:00.000Z";
const startsAt = "2026-10-02T10:00:00.000Z";
const endsAt = "2026-10-02T10:30:00.000Z";
const token = "trustedHostTokenForCall";

test("E2E-224 signed standalone appointment reads require a transient patient proof",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_verified_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const suffix = randomUUID().slice(0, 8);
    const scope = { tenantId: `proof-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
    const accountSid = `AC${"1".repeat(32)}`;
    const authToken = "synthetic-twilio-test-token";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const dialedNumber = "+6125550199";
    const callerPhone = "+6145550101";
    const readiness = async () => ok(true as const);
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", readiness, false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    assert.ok((await policy.changeGreeting(scope, "0", { scope, version: "verified-read-greeting-v1",
      ownerRef: "test-operator", approved: true, approvedText: "Welcome to the clinic.",
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" },
    "test-operator")).ok);
    const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
      publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
      bindingKey: Buffer.alloc(32, 0x35), now: () => new Date(at) });
    const routingHost = new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber,
      ...scope, routeVersion: "v1" }]);
    const clinicScope = { tenantId: scope.tenantId, clinicId: scope.clinicId };
    let indexedKind: CallerCandidates["kind"] = "one";
    const patientProvider: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      const phoneFor = (id: string) => id === "22" && indexedKind === "one" ? "0400 999 999" : "0455 501 01";
      const patient = (id: string) => ({ id, archived_at: null,
        first_name: "PRIVATE PATIENT CANARY", notes: "PRIVATE NOTE CANARY",
        patient_phone_numbers: [{ number: phoneFor(id), phone_type: "Mobile" }] });
      if (path === "/v1/patients") return Response.json({ total_entries: 2,
        patients: [patient("22"), patient("23")] });
      if (path === "/v1/patients/22" || path === "/v1/patients/23") {
        return Response.json(patient(path.slice(-2)));
      }
      throw new Error("unexpected synthetic patient request");
    };
    const reader = ClinikoPatientCandidateReader.create({ scope: clinicScope,
      apiKey: "synthetic-key-au5", contactEmail: "test@example.com" }, patientProvider);
    assert.ok(reader.ok);
    const index = new PostgresPatientPhoneIndex(db);
    const lookup = new ClinikoPhoneLookup(reader.value, index, "61", 60_000,
      undefined, new PostgresPatientPhoneScan(db));
    let detailReads = 0;
    let writes = 0;
    const provider: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== "GET") writes += 1;
      if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11",
        time_zone_identifier: "Australia/Sydney", archived_at: null });
      assert.equal(url.pathname, "/v1/individual_appointments");
      detailReads += 1;
      assert.equal(url.searchParams.getAll("q[]").includes("patient_id:=23"), true);
      return Response.json({ total_entries: 1, individual_appointments: [{ id: "44",
        starts_at: startsAt, ends_at: endsAt,
        patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/23" } },
        business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
        cancelled_at: null, archived_at: null, deleted_at: null,
        patient_name: "PRIVATE PATIENT CANARY", notes: "PRIVATE NOTE CANARY" }] });
    };

    async function callCase(kind: CallerCandidates["kind"], options: {
      selectedPatient?: string; enabled?: boolean; issue?: boolean; revoke?: boolean; configured?: boolean;
      anonymous?: boolean; verifierTimeout?: boolean; disableAfterProof?: boolean;
    } = {}) {
      indexedKind = kind;
      assert.ok((await lookup.refresh(clinicScope)).ok);
      if (kind === "indexStale") {
        const head = await index.head(clinicScope);
        assert.ok(head.ok && head.value);
        assert.ok((await index.markStale(clinicScope, head.value.generation)).ok);
      }
      const caseId = randomUUID().replaceAll("-", "").slice(0, 24);
      const callSid = `CA${caseId.padEnd(32, "0")}`;
      const streamSid = `MZ${caseId.padEnd(32, "1")}`;
      const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber,
        From: options.anonymous ? "" : callerPhone };
      const answered = ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound",
        contentType: "application/x-www-form-urlencoded",
        signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
        body: new URLSearchParams(form).toString() });
      assert.ok(answered.ok);
      const binding = answered.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
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
      let verified: VerifiedAppointmentReadSession | undefined;
      let verificationRef = "unverified-reference";
      let candidateReads = 0;
      let verificationEnabled = options.enabled !== false;
      const before = detailReads;
      const verifiedAppointmentRead: NonNullable<TransientVoiceConfig["verifiedAppointmentRead"]> =
        (receipt, inbound, sessionId) => {
          const result = VerifiedAppointmentReadSession.create({ receipt, inbound, sessionId,
            policyVersion: "verification-v1", maxAttempts: 2,
            lookup: { async candidates(readScope, number) {
              candidateReads += 1;
              assert.equal(readScope.tenantId, scope.tenantId);
              assert.equal(readScope.clinicId, scope.clinicId);
              assert.equal(number, callerPhone);
              return lookup.candidates(readScope, number);
            } },
            authority: { async attest(request) {
              if (options.verifierTimeout) return new Promise<never>(() => undefined);
              return ok({ scope: request.scope,
              callId: request.callId, sessionId: request.sessionId,
              patientId: options.selectedPatient ?? "23", operations: [request.operation],
              policyVersion: request.policyVersion }); } },
            policy: { async current() { return ok({ scope, enabled: verificationEnabled,
              version: "verification-v1" }); } },
            clock: () => at,
            ...(options.verifierTimeout ? { timeoutMs: 50 } : {}),
            cliniko: { apiKey: "synthetic-key-au5", contactEmail: "test@example.com", businessId: "11" },
            fetchPort: provider });
          assert.ok(result.ok);
          verified = result.value;
          return result.value;
        };
      const composed = await createStandaloneTransientVoiceCall({ db: db!, routingHost,
        stream: authenticated.value,
        send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; },
        ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcriptionFactory: sessionId => ({
          async accept() { return ok([]); },
          async flush(generation) { return ok([{ kind: "segmentFinal", sessionId, generation,
            utteranceId: "request", text: "What is my appointment?", quality: "clear" }]); },
        }) }),

        resolveIntent: async turn => {
          assert.equal(JSON.stringify(turn).includes(callerPhone), false);
          assert.equal(JSON.stringify(turn).includes("PRIVATE PATIENT CANARY"), false);
          return ok({ kind: "appointments", verificationRef, from, to });
        },
        ...(options.configured === false ? {} : { verifiedAppointmentRead }),
        readiness, now: () => at, mediaOptions: { silenceMs: 100 },
      });
      assert.ok(composed.ok);
      const call = composed.value;
      assert.equal((await call.receive(connected)).ok, true);
      assert.equal((await call.receive(start)).ok, true);
      if (options.configured === false) assert.equal(verified, undefined);
      else assert.ok(verified, "admission constructs the verified read in the bound call");
      const mark = (sent[1]?.mark as { name: string }).name;
      assert.equal((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
        mark: { name: mark } }))).ok, true);
      if (options.issue) {
        assert.ok(verified);
        const issued = await verified.issueReadProof(token);
        if ((kind === "one" || kind === "multiple") &&
            options.selectedPatient !== "24" && options.enabled !== false &&
            !options.anonymous && !options.verifierTimeout) {
          assert.ok(issued.ok);
          verificationRef = issued.value.verificationRef;
        } else assert.equal(issued.ok, false);
      }
      if (options.disableAfterProof) verificationEnabled = false;
      if (options.revoke) { assert.ok(verified); verified.dispose(); }
      for (let index = 0; index < 7; index += 1) {
        assert.equal((await call.receive(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
          media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20),
            payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }))).ok, true);
      }
      assert.equal((await call.receive(JSON.stringify({ event: "stop", sequenceNumber: "10", streamSid,
        stop: { accountSid, callSid } }))).ok, true);
      if (verified) assert.equal((await verified.issueReadProof(token)).ok, false, "disconnect revokes the proof");
      return { spoken, detailReads: detailReads - before, candidateReads, callSid };
    }

    const unconfigured = await callCase("one", { configured: false });
    const unverified = await callCase("one");
    const wrongPatient = await callCase("multiple", { issue: true, selectedPatient: "24" });
    const stale = await callCase("indexStale", { issue: true });
    const anonymous = await callCase("one", { issue: true, anonymous: true });
    const timedOut = await callCase("one", { issue: true, verifierTimeout: true });
    const disabled = await callCase("one", { issue: true, enabled: false });
    const withdrawn = await callCase("one", { issue: true, disableAfterProof: true });
    const revoked = await callCase("one", { issue: true, revoke: true });
    for (const denied of [unconfigured, unverified, wrongPatient, stale, anonymous,
      timedOut, disabled, withdrawn, revoked]) {
      assert.equal(denied.detailReads, 0);
      assert.equal(JSON.stringify(denied.spoken).includes("PRIVATE"), false);
      assert.equal(JSON.stringify(denied.spoken).includes("appointment on"), false);
    }
    assert.equal(unconfigured.candidateReads, 0, "the live-default composition cannot look up a caller");
    assert.equal(unverified.candidateReads, 0, "a caller request alone cannot trigger phone lookup");
    assert.equal(anonymous.candidateReads, 0, "an anonymous caller cannot trigger phone lookup");
    assert.equal(disabled.candidateReads, 0, "a disabled policy cannot trigger phone lookup");
    const single = await callCase("one", { issue: true });
    assert.equal(single.detailReads, 1);
    assert.equal(single.candidateReads >= 2, true, "proof rechecks the single current candidate");
    const verified = await callCase("multiple", { issue: true });
    assert.equal(verified.detailReads, 1);
    assert.equal(verified.candidateReads >= 2, true, "proof rechecks shared-number candidates");
    assert.match(JSON.stringify(verified.spoken), /Friday 2 October/);
    assert.equal(JSON.stringify(verified.spoken).includes("PRIVATE"), false);
    assert.equal(writes, 0);
    const links = await db.selectFrom("patient_phone_index").select(["normalized_phone", "patient_id"])
      .where("tenant_id", "=", scope.tenantId as never).orderBy("patient_id").execute();
    assert.deepEqual(links.map(link => [link.normalized_phone, link.patient_id]),
      [[callerPhone, "22"], [callerPhone, "23"]]);
    const canaries = [...[unconfigured, unverified, wrongPatient, stale, anonymous, timedOut,
      disabled, withdrawn, revoked, single, verified]
      .map(item => item.callSid),
      "PRIVATE PATIENT CANARY", "PRIVATE NOTE CANARY", startsAt].map((value, index) =>
      ({ label: `private_${index}`, value }));
    for (let offset = 0; offset < canaries.length; offset += 12) {
      const batch = canaries.slice(offset, offset + 12);
      assert.deepEqual(await scanPatientDataCanaries(db, batch), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), batch), []);
    }
  } finally {
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
