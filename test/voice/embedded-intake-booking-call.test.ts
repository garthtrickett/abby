import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import { digestActionRequest } from "../../src/core/digest.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { IntakeEvidenceQuery } from "../../src/core/host.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence } from "../../src/standalone/transient-intake-authority.ts";
import { callIdFor } from "../../src/voice/admission.ts";

const now = "2026-09-29T10:00:00.000Z";
const scope = { tenantId: "intake-voice", clinicId: "clinic", locationId: "main" };
const draftRef = "approved-draft-1";
const offer = { scope, offerRef: "offer-1", serviceRef: "physio",
  startsAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-09-29T11:00:00.000Z" };

class IntakePolicyStore extends MemoryPolicyStore {
  override async read(location: LocationScope) {
    const read = await super.read(location);
    return read.ok ? ok({ ...read.value, staffWorkEnabled: true,
      capabilities: { ...read.value.capabilities, intake: "execute" as const } }) : read;
  }
}

class IntakeThenFailedBookingHost extends ReferenceClinicHost {
  createdRef: string | undefined;
  intakeWrites = 0;
  bookingWrites = 0;
  bookingReconciles = 0;
  readonly bookingOutcome: "rejected" | "uncertain";
  private readonly expectedCallId: string;
  private readonly expectedSessionId: string;
  private readonly invalidConsent: boolean;
  private readonly createPatient: (() => Promise<string | undefined>) | undefined;
  constructor(bookingOutcome: "rejected" | "uncertain", expectedCallId: string, expectedSessionId: string,
              invalidConsent = false, createPatient?: () => Promise<string | undefined>) {
    super([{ scope, patientRef: "created-patient-1", verificationRef: "created-proof-1",
      expiresAt: "2026-09-29T11:00:00.000Z" }], [offer]);
    this.bookingOutcome = bookingOutcome;
    this.expectedCallId = expectedCallId;
    this.expectedSessionId = expectedSessionId;
    this.invalidConsent = invalidConsent;
    this.createPatient = createPatient;
  }

  async resolveIntake(query: IntakeEvidenceQuery) {
    const { scope: location, callId, sessionId, policyVersion, draftRef: ref, now: at } = query;
    if (location.tenantId !== scope.tenantId || location.clinicId !== scope.clinicId ||
        location.locationId !== scope.locationId || callId !== this.expectedCallId ||
        sessionId !== this.expectedSessionId || policyVersion !== "1" || ref !== draftRef ||
        !Number.isFinite(Date.parse(at)) || Date.parse(at) >= Date.parse("2026-09-29T11:00:00.000Z")) {
      return err({ kind: "notFound" as const, target: "patient" as const });
    }
    return ok({ kind: "intake" as const, scope, approvedDraftRef: ref,
      consentRef: this.invalidConsent ? "" : "host-consent-1", duplicateCheckRef: "host-duplicate-check-1" });
  }

  override async resolveBooking(location: LocationScope, verificationRef: string, offerRef: string, at: string) {
    if (!this.createdRef) return err({ kind: "notFound" as const, target: "patient" as const });
    if (this.createPatient) {
      if (location.tenantId !== scope.tenantId || location.clinicId !== scope.clinicId ||
          location.locationId !== scope.locationId || verificationRef !== "created-proof-1" ||
          offerRef !== offer.offerRef || Date.parse(at) >= Date.parse(offer.expiresAt)) {
        return err({ kind: "notFound" as const, target: "patient" as const });
      }
      return ok({ kind: "book" as const, patient: { scope, patientRef: this.createdRef,
        verificationRef, expiresAt: "2026-09-29T11:00:00.000Z" }, offer });
    }
    return super.resolveBooking(location, verificationRef, offerRef, at);
  }

  override async write(mutation: HostMutation, at: string): Promise<HostWriteReceipt> {
    if (mutation.kind === "intake" && mutation.request.kind === "intake") {
      this.intakeWrites += 1;
      if (mutation.request.approvedDraftRef !== draftRef || mutation.payloadDigest !== digestActionRequest(mutation.request)) {
        return { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
      }
      this.createdRef = this.createPatient ? await this.createPatient() : "created-patient-1";
      if (!this.createdRef) return { kind: "uncertain", actionKey: mutation.actionKey,
        reconcileAfter: at, deadline: "2026-09-29T10:10:00.000Z" };
      return { kind: "committed", actionKey: mutation.actionKey, hostRef: this.createdRef };
    }
    if (mutation.kind === "book" && mutation.request.kind === "book") {
      this.bookingWrites += 1;
      assert.equal(mutation.request.patient.patientRef, this.createdRef);
      return this.bookingOutcome === "rejected"
        ? { kind: "rejected", actionKey: mutation.actionKey, reason: "conflict" }
        : { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: at,
          deadline: "2026-09-29T10:10:00.000Z" };
    }
    return { kind: "unsupported", actionKey: mutation.actionKey };
  }

  override async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    if (mutation.kind === "book") {
      this.bookingReconciles += 1;
      return { kind: "stillUnknown", actionKey: mutation.actionKey };
    }
    return super.reconcile(mutation);
  }
}

async function runCall(bookingOutcome: "rejected" | "uncertain", invalidDraft = false,
                       invalidConsent = false, createPatient?: () => Promise<string | undefined>,
                       uncertainIntake = false) {
  const event = { key: { accountRef: "buyer-provider", providerCallRef: `intake-${bookingOutcome}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session-${bookingOutcome}`;
  const ledger = new MemoryLedger();
  const policy = new IntakePolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new IntakeThenFailedBookingHost(bookingOutcome, callId, sessionId, invalidConsent, createPatient);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: "buyer-provider",
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  const callerTurns = ["Register me", "Yes", "Book physio", "Yes"];
  let utterance = 0;
  let mediaSequence = 0;
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host,
    readiness: async () => ok(true), now: () => now,
    resolveIntent: async turn => ok(turn.text === "Register me"
      ? { kind: "intake", draftRef: invalidDraft ? "unapproved-draft" : draftRef }
      : turn.text === "Book physio"
        ? { kind: "book", verificationRef: "created-proof-1", offerRef: offer.offerRef }
        : { kind: "affirm" }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      const text = callerTurns[utterance++];
      assert.ok(text);
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text, quality: "clear" }]);
    } },
    synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, sequence) {
      chunks.set(playbackId, [...(chunks.get(playbackId) ?? []), sequence]);
      return "queued" as const;
    }, async finishQueue() { return "queued" as const; }, async clear() { return true; } },
    mediaOptions: { silenceMs: 100 },
  });

  async function play(delivery: { kind: string; playbackId?: string }) {
    assert.equal(delivery.kind, "queued");
    assert.ok(delivery.playbackId);
    const sequences = chunks.get(delivery.playbackId);
    assert.ok(sequences?.length);
    const result = await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId,
      lastSequence: sequences.at(-1)!, status: "played" }, now);
    assert.ok(result.ok);
  }

  async function speak() {
    let completed: Awaited<ReturnType<typeof call.acceptMedia>> | undefined;
    for (let frame = 0; frame < 7; frame += 1) {
      const bytes = new Uint8Array(640);
      if (frame < 2) {
        const view = new DataView(bytes.buffer);
        for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true);
      }
      completed = await call.acceptMedia({ sessionId, sequence: mediaSequence,
        capturedAt: new Date(Date.parse(now) + mediaSequence * 20).toISOString(), bytes });
      mediaSequence += 1;
      assert.ok(completed.ok, completed.ok ? "" : completed.error.kind);
    }
    assert.ok(completed?.ok);
    assert.equal(completed.value.kind, "turnCompleted");
    await play(completed.value.delivery);
  }

  const started = await call.begin(now);
  assert.ok(started.ok);
  assert.equal(started.value.kind, "admitted");
  await play(started.value.delivery);
  await speak();
  assert.equal(host.intakeWrites, 0, "the intake confirmation must be played before a write");
  if (invalidDraft || invalidConsent) {
    const state = await ledger.read(callId, scope);
    assert.ok(state.ok);
    assert.deepEqual(Object.keys(state.value.actions), []);
    assert.equal(spoken.at(-1), invalidDraft
      ? "I can't verify approved intake details for this call."
      : "I can't check approved intake details right now.");
    await call.disconnect(now);
    return;
  }
  await speak();
  assert.equal(host.intakeWrites, 1);
  if (uncertainIntake) {
    const state = await ledger.read(callId, scope);
    assert.ok(state.ok);
    assert.equal(host.createdRef, undefined);
    assert.equal(Object.values(state.value.actions).find(action => action.kind === "intake")?.status, "uncertain");
    assert.equal(host.bookingWrites, 0);
    assert.equal(spoken.at(-1), "I can't confirm that action yet. It is pending review.");
    assert.equal(spoken.includes("Your details were saved. No appointment is confirmed yet."), false);
    assert.equal(spoken.includes("Your booking is confirmed."), false);
    assert.deepEqual(await host.resolveBooking(scope, "created-proof-1", offer.offerRef, now),
      err({ kind: "notFound", target: "patient" }));
    await call.disconnect(now);
    return;
  }
  assert.equal(spoken.at(-1), "Your details were saved. No appointment is confirmed yet.");
  await speak();
  assert.equal(host.bookingWrites, 0, "the booking confirmation must be played before a write");
  await speak();

  const state = await ledger.read(callId, scope);
  assert.ok(state.ok);
  const intake = Object.values(state.value.actions).find(action => action.kind === "intake");
  const booking = Object.values(state.value.actions).find(action => action.kind === "book");
  assert.equal(intake?.status, "committed");
  assert.equal(intake.hostRef, host.createdRef);
  assert.equal(booking?.status, bookingOutcome === "rejected" ? "rejected" : "uncertain");
  assert.equal(Object.values(state.value.staffItems)[0]?.linkedActionKey, booking?.key);
  assert.equal(host.bookingWrites, 1);
  assert.equal(spoken.includes("Your booking is confirmed."), false);
  assert.equal(spoken.at(-1), bookingOutcome === "rejected"
    ? "That action was not completed."
    : "I can't confirm that action yet. It is pending review.");
  const reception = createEmbeddedTextComposition(ledger, policy, host);
  const drained = await reception.drain(scope, callId, "2026-09-29T10:10:00.000Z");
  assert.ok(drained.ok);
  assert.equal(host.tasks(scope).length, 1, "the authorized embedded host opens linked follow-up");
  if (bookingOutcome === "uncertain") {
    assert.equal(host.bookingReconciles, 1);
    assert.equal(drained.value.actions[booking!.key]?.status, "needsReview");
    assert.equal(host.bookingWrites, 1, "reconciliation never resends the booking");
  } else assert.equal(host.bookingReconciles, 0);
  await call.disconnect(now);
}

test("E2E-016 embedded voice retains created patient after rejected booking", () => runCall("rejected"));
test("E2E-073 embedded voice retains created patient after uncertain booking", () => runCall("uncertain"));
test("E2E-016 embedded voice rejects an unapproved intake draft without a write", () => runCall("rejected", true));
test("E2E-016 embedded voice rejects incomplete host consent evidence without a write", () => runCall("rejected", false, true));

test("E2E-016 a TCP reset after patient creation never claims saved details or replays the POST", async () => {
  let posts = 0;
  let created = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.url?.split("?")[0], "/v1/patients");
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ total_entries: 0, patients: [] }));
      return;
    }
    assert.equal(request.method, "POST");
    posts += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    assert.equal(body.first_name, "Synthetic");
    assert.equal(body.last_name, "Caller");
    created = true;
    response.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const providerFetch: typeof fetch = (input, init) => {
    const original = new URL(String(input));
    assert.equal(original.origin, "https://api.au5.cliniko.com");
    return fetch(`http://127.0.0.1:${address.port}${original.pathname}${original.search}`, init);
  };
  try {
    await runCall("rejected", false, false, async () => {
      const callId = callIdFor({ accountRef: "buyer-provider", providerCallRef: "intake-rejected" });
      const sessionId = "session-rejected";
      const refs = { draftRef, consentRef: "consent:local-reset", authorityRef: "authority:local-reset" };
      const evidence: HostIntakeEvidence = { scope, callId, sessionId, policyVersion: "1", ...refs,
        draft: { firstName: "Synthetic", lastName: "Caller", email: "synthetic-caller@example.test",
          dateOfBirth: "1990-05-21", patientPhone: "+61455500000", phoneType: "Mobile" },
        caller: "patient", privacyAccepted: true, proxyAuthorized: false,
        expiresAt: "2026-09-29T10:05:00.000Z" };
      const authority = new TransientIntakeAuthority({ scope, callId, sessionId, policyVersion: "1",
        clock: () => now, source: { async resolve(query) {
          return query.callId === callId && query.sessionId === sessionId &&
            query.draftRef === draftRef && query.consentRef === refs.consentRef &&
            query.authorityRef === refs.authorityRef ? ok(evidence) : err({ kind: "denied" as const });
        } } });
      try {
        const prepared = await authority.prepare(refs.draftRef, refs.consentRef, refs.authorityRef);
        assert.ok(prepared.ok);
        const edge = ClinikoPatientIntakeEdge.create({ scope, apiKey: "synthetic-key-au5",
          contactEmail: "dev@example.test" }, authority, providerFetch, () => now);
        assert.ok(edge.ok);
        const first = await edge.value.createOnce(prepared.value);
        assert.deepEqual(first, ok({ kind: "uncertain" }));
        assert.deepEqual(await edge.value.createOnce(prepared.value), err({ kind: "invalidQuery" }));
        return undefined;
      } finally { authority.dispose(); }
    }, true);
    assert.equal(created, true, "the provider committed before dropping its response");
    assert.equal(posts, 1, "uncertain intake cannot send a second patient POST");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("C-LIVE-40 embedded voice keeps a real demo-created patient after synthetic booking rejection",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" || !process.env.ABBY_CLINIKO_API_KEY ||
    !process.env.ABBY_CLINIKO_CONTACT_EMAIL, timeout: 120_000 }, async () => {
  const apiKey = process.env.ABBY_CLINIKO_API_KEY!;
  const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
  const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
  assert.ok(shard);
  const base = `https://api.${shard}.cliniko.com/v1`;
  const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json", "User-Agent": `Abby (${contactEmail})` };
  const marker = randomUUID().replaceAll("-", "");
  const patient = { firstName: "Abby", lastName: `SyntheticVoice${marker.slice(0, 16)}`,
    email: `abby-intake-voice+${marker}@example.test`, dateOfBirth: "1990-05-21",
    patientPhone: `+614559${randomInt(10_000, 100_000)}`, phoneType: "Mobile" as const };
  let attempted = false;
  let responseId: string | undefined;

  async function request(method: "GET" | "POST", path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      const response = await fetch(`${base}${path}`, { method, headers, redirect: "error",
        signal: AbortSignal.timeout(15_000) });
      const raw = await response.text();
      if (raw.length > 100_000) throw new Error("oversized response");
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid response");
      return { status: response.status, body: parsed as Record<string, unknown> };
    } catch { throw new Error("Cliniko demo read or cleanup unavailable"); }
  }

  try {
    await runCall("rejected", false, false, async () => {
      const callId = callIdFor({ accountRef: "buyer-provider", providerCallRef: "intake-rejected" });
      const sessionId = "session-rejected";
      const refs = { draftRef, consentRef: `consent:${marker}`, authorityRef: `authority:${marker}` };
      const evidence: HostIntakeEvidence = { scope, callId, sessionId, policyVersion: "1", ...refs,
        draft: patient, caller: "patient", privacyAccepted: true, proxyAuthorized: false,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      const authority = new TransientIntakeAuthority({ scope, callId, sessionId, policyVersion: "1",
        source: { async resolve(query) {
          return query.callId === callId && query.sessionId === sessionId &&
            query.draftRef === draftRef && query.consentRef === refs.consentRef &&
            query.authorityRef === refs.authorityRef ? ok(evidence) : err({ kind: "denied" as const });
        } } });
      try {
        const prepared = await authority.prepare(refs.draftRef, refs.consentRef, refs.authorityRef);
        assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error.kind);
        const edge = ClinikoPatientIntakeEdge.create({ scope, apiKey, contactEmail }, authority,
          async (input, init) => {
            if (init?.method === "POST") attempted = true;
            const response = await fetch(input, init);
            if (init?.method === "POST") {
              const row: unknown = await response.clone().json();
              if (typeof row === "object" && row !== null && "id" in row &&
                  typeof row.id === "string" && /^[1-9][0-9]{0,18}$/.test(row.id)) responseId = row.id;
            }
            return response;
          });
        assert.equal(edge.ok, true, edge.ok ? "" : edge.error.kind);
        const created = await edge.value.createOnce(prepared.value);
        assert.equal(created.ok, true, created.ok ? "" : created.error.kind);
        if (created.value.kind !== "created") throw new Error("demo intake receipt unavailable");
        assert.ok(responseId && created.value.patientRef === `cliniko:patient:${responseId}`);
        return created.value.patientRef;
      } finally { authority.dispose(); }
    });
  } finally {
    if (attempted) {
      const query = new URLSearchParams({ page: "1", per_page: "2" });
      query.append("q[]", `email:=${patient.email}`);
      query.append("q[]", `date_of_birth:=${patient.dateOfBirth}`);
      const listed = await request("GET", `/patients?${query}`);
      const rows = listed.body.patients;
      if (listed.status !== 200 || !Array.isArray(rows) || listed.body.total_entries !== 1 || rows.length !== 1) {
        throw new Error("Cliniko demo patient cleanup reconciliation uncertain");
      }
      const candidate = rows[0] as Record<string, unknown>;
      const id = candidate.id;
      if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) ||
          (responseId && responseId !== id) || candidate.first_name !== patient.firstName ||
          candidate.last_name !== patient.lastName || candidate.email !== patient.email ||
          candidate.date_of_birth !== patient.dateOfBirth) {
        throw new Error("Cliniko demo patient cleanup identity uncertain");
      }
      const detail = await request("GET", `/patients/${id}`);
      const phones = detail.body.patient_phone_numbers;
      if (detail.status !== 200 || detail.body.id !== id || !Array.isArray(phones) ||
          !phones.some(value => typeof value === "object" && value !== null &&
            "number" in value && value.number === patient.patientPhone)) {
        throw new Error("Cliniko demo patient cleanup detail uncertain");
      }
      const archived = await request("POST", `/patients/${id}/archive`);
      const verified = await request("GET", `/patients/${id}?q%5B%5D=archived_at%3A*`);
      if (archived.status !== 204 || verified.status !== 200 || verified.body.id !== id ||
          !verified.body.archived_at) throw new Error("Cliniko demo patient archive unverified");
    }
  }
});
