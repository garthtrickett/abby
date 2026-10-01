import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TransientClinikoAppointmentChangeHost } from "../../src/standalone/transient-cliniko-appointment-change-host.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import { callIdFor } from "../../src/voice/admission.ts";

type Kind = "cancel" | "reschedule";
type Scenario = "success" | "noProof" | "wrongPatient" | "ambiguous" |
  "changedTerms" | "changedTarget" | "changedProviderTarget" | "noStaff" |
  "wrongCredential" | "lostResponse" | "moveConflict" | "heldPatch";
const now = "2026-10-01T10:00:00.000Z";
const scope = { tenantId: "provider-change", clinicId: "clinic", locationId: "main" };
const base = "https://api.au5.cliniko.com/v1";
const oldStart = "2026-10-08T11:00:00+07:00";
const oldEnd = "2026-10-08T11:30:00+07:00";
const newStart = "2026-10-08T12:00:00+07:00";
const credentialFingerprint = clinikoCredentialFingerprint("synthetic-key-au5");

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(check(), "expected provider phase did not start");
}

async function bounded<Value>(pending: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<Value>((_, reject) => {
      timer = setTimeout(() => reject(new Error("call stop timed out")), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

class ChangePolicyStore extends MemoryPolicyStore {
  private readonly operation: Kind;
  private readonly staffEnabled: boolean;
  constructor(operation: Kind, staffEnabled: boolean) {
    super("execute", () => now, async () => ok(true));
    this.operation = operation;
    this.staffEnabled = staffEnabled;
  }
  override async read(location: LocationScope) {
    const result = await super.read(location);
    return result.ok ? ok({ ...result.value, staffWorkEnabled: this.staffEnabled,
      capabilities: { ...result.value.capabilities,
      [this.operation]: "execute" as const } }) : result;
  }
}

async function fixture(kind: Kind, scenario: Scenario, writerBusinessId = "11",
                       writerApiKey = "synthetic-key-au5", providerFetch?: typeof fetch) {
  const event = { key: { accountRef: "synthetic-provider", providerCallRef: `change-${crypto.randomUUID()}` },
    dialedNumber: "+6125550199", presentedCallerNumber: "+61400111222", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session:${crypto.randomUUID()}`;
  const ledger = new MemoryLedger(async () => ok(true));
  const policy = new ChangePolicyStore(kind, scenario !== "noStaff");
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const proof = new TransientPatientProofHost({ scope, callId, sessionId,
    presentedCallerNumber: event.presentedCallerNumber, policyVersion: "1", maxAttempts: 2,
    lookup: { async candidates() { return ok({ kind: "one" as const, candidateIds: ["42"] }); } },
    authority: { async attest(query) { return ok({ scope, callId, sessionId,
      patientId: scenario === "wrongPatient" ? "99" : "42",
      policyVersion: query.policyVersion, operations: [query.operation] }); } },
    policy: { async current() { return ok({ scope, enabled: true, version: "1" }); } },
    clock: () => now,
  });
  let appointmentStart = scenario === "changedProviderTarget" ? "2026-10-08T10:00:00+07:00" : oldStart;
  let appointmentEnd = oldEnd;
  let cancelled = false;
  let patchCount = 0;
  let readCount = 0;
  let conflictReads = 0;
  let conflict = scenario === "moveConflict";
  let releasePatch!: (response: Response) => void;
  const heldPatch = new Promise<Response>(resolve => { releasePatch = resolve; });
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    if (url.pathname.endsWith("/conflicts")) {
      conflictReads += 1;
      return Response.json({ conflicts: { exist: conflict } });
    }
    if (init?.method === "PATCH") {
      patchCount += 1;
      if (kind === "cancel") {
        assert.equal(url.pathname, "/v1/individual_appointments/91/cancel");
        cancelled = true;
        if (scenario === "lostResponse") throw new Error("response lost after cancellation");
        if (scenario === "heldPatch") return heldPatch;
        return new Response(null, { status: 204 });
      }
      assert.equal(url.pathname, "/v1/individual_appointments/91");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.starts_at, newStart);
      assert.equal(body.ends_at, null);
      appointmentStart = newStart;
      appointmentEnd = "2026-10-08T12:30:00+07:00";
      if (scenario === "lostResponse") throw new Error("response lost after move");
      if (scenario === "heldPatch") return heldPatch;
      return Response.json({});
    }
    assert.equal(init?.method, "GET");
    assert.equal(url.pathname, "/v1/individual_appointments/91");
    readCount += 1;
    return Response.json({ id: "91", starts_at: appointmentStart, ends_at: appointmentEnd,
      cancelled_at: cancelled ? now : null, archived_at: null, deleted_at: null,
      patient: { links: { self: `${base}/patients/42` } },
      business: { links: { self: `${base}/businesses/11` } },
      practitioner: { links: { self: `${base}/practitioners/22` } },
      appointment_type: { links: { self: `${base}/appointment_types/33` } },
      notes: "Private fixture note" });
  };
  const writerConfig = { scope, apiKey: writerApiKey,
    contactEmail: "dev@example.test", businessId: writerBusinessId };
  const cancellation = ClinikoCancellationWriter.create(writerConfig, providerFetch ?? provider, () => now);
  const rescheduling = ClinikoRescheduleWriter.create(writerConfig, providerFetch ?? provider, () => now);
  assert.ok(cancellation.ok && rescheduling.ok);
  const staff = new ReferenceClinicHost([], []);
  let authorityReads = 0;
  const host = new TransientClinikoAppointmentChangeHost({ scope, callId, sessionId,
    policyVersion: "1", ledger, policy, proof, businessId: "11", credentialFingerprint,
    cancellation: cancellation.value, rescheduling: rescheduling.value, staff,
    authority: { async resolve(query) {
      authorityReads += 1;
      if (scenario === "ambiguous") return err({ kind: "ambiguous" as const, target: "appointment" as const });
      assert.equal(query.patientId, "42");
      const target = { scope, appointmentRef: "91", patientRef: "42",
        startsAt: query.phase === "commit" && scenario === "changedTarget"
          ? "2026-10-08T10:00:00+07:00" : oldStart,
        endsAt: oldEnd, timeZone: "Australia/Sydney" };
      const terms = { version: query.phase === "commit" && scenario === "changedTerms" ? "fee-2" : "fee-1",
        approvedText: kind === "cancel" ? "No cancellation fee applies." : "No rescheduling fee applies.",
        expiresAt: "2026-10-01T10:04:00.000Z" };
      const common = { scope, callId, sessionId, policyVersion: "1", patientId: "42",
        targetRef: "selected-91", businessId: "11", practitionerId: "22", appointmentTypeId: "33",
        credentialFingerprint: scenario === "wrongCredential"
          ? clinikoCredentialFingerprint("synthetic-rotated-key-au5") : credentialFingerprint,
        target, terms };
      return ok(kind === "cancel" ? { ...common, kind: "cancel" as const, cancellationReason: 50 as const }
        : { ...common, kind: "reschedule" as const,
          offer: { scope, offerRef: "new-slot", serviceRef: "physiotherapy",
            startsAt: newStart, expiresAt: "2026-10-01T10:04:00.000Z" } });
    } }, clock: () => now,
  });
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  let verificationRef = "unverified-ref";
  let callStops = 0;
  let utterance = 0;
  let mediaSequence = 0;
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host,
    readiness: async () => ok(true), now: () => now, onCallStop: () => {
      callStops += 1;
      host.dispose();
    },
    resolveIntent: async turn => ok(turn.text === "Yes" ? { kind: "affirm" }
      : kind === "cancel" ? { kind: "cancel", verificationRef, targetRef: "selected-91" }
        : { kind: "reschedule", verificationRef, targetRef: "selected-91", offerRef: "new-slot" }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      utterance += 1;
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text: utterance === 1 ? "Change my appointment" : "Yes",
        quality: "clear" }]);
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
    const played = await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId,
      lastSequence: sequences.at(-1)!, status: "played" }, now);
    assert.ok(played.ok, played.ok ? "" : played.error.kind);
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
    return completed.value;
  }
  async function begin() {
    const started = await call.begin(now);
    assert.ok(started.ok && started.value.kind === "admitted");
    await play(started.value.delivery);
    if (scenario !== "noProof") {
      const issued = await proof.issue("syntheticHostTokenOne", kind === "cancel"
        ? "appointments.cancel" : "appointments.reschedule");
      if (scenario === "wrongPatient") assert.equal(issued.ok, false);
      else {
        assert.ok(issued.ok);
        verificationRef = issued.value.verificationRef;
      }
    }
  }
  return { begin, speak, play, call, host, ledger, policy, spoken, staff,
    clearConflict: () => { conflict = false; },
    releasePatch: () => releasePatch(kind === "cancel"
      ? new Response(null, { status: 204 }) : Response.json({})),
    get patchCount() { return patchCount; }, get readCount() { return readCount; },
    get conflictReads() { return conflictReads; }, get authorityReads() { return authorityReads; },
    get callStops() { return callStops; },
    state: async () => {
      const state = await ledger.read(callId, scope);
      assert.ok(state.ok);
      return state.value;
    },
    drain: async (at = now) => createEmbeddedTextComposition(ledger, policy, host).drain(scope, callId, at),
    close: async () => { await call.disconnect(now); host.dispose(); },
  };
}

for (const kind of ["cancel", "reschedule"] as const) {
  test(`E2E-007/066 provider-backed ${kind} call confirms only after exact Cliniko observation`, async () => {
    const app = await fixture(kind, "success");
    await app.begin();
    const details = await app.speak();
    assert.equal(app.patchCount, 0);
    assert.match(app.spoken.at(-1) ?? "", /1[012] October|8 October/);
    assert.match(app.spoken.at(-1) ?? "", /fee applies/);
    await app.play(details.delivery);
    const affirmed = await app.speak();
    assert.equal(app.patchCount, 1);
    assert.equal(app.authorityReads, 2);
    assert.match(app.spoken.at(-1) ?? "", /is confirmed/);
    const action = Object.values((await app.state()).actions)[0];
    assert.equal(action?.status, "committed");
    assert.ok(action);
    assert.equal(app.spoken.join(" ").includes("Private fixture note"), false);
    assert.equal(JSON.stringify(await app.state()).includes("Private fixture note"), false);
    assert.deepEqual(await app.host.write(action.mutation, now),
      { kind: "rejected", actionKey: action.key, reason: "forbidden" });
    assert.equal(app.patchCount, 1);
    await app.play(affirmed.delivery);
    assert.ok((await app.drain()).ok);
    assert.equal(app.patchCount, 1);
    await app.close();
  });

  test(`E2E-007/066 provider-backed ${kind} denies absent proof and changed target or fee terms`, async () => {
    for (const scenario of ["noProof", "wrongPatient", "ambiguous", "changedTerms",
      "changedTarget", "changedProviderTarget", "noStaff", "wrongCredential"] as const) {
      const app = await fixture(kind, scenario);
      await app.begin();
      const details = await app.speak();
      assert.equal(app.patchCount, 0);
      await app.play(details.delivery);
      if (scenario === "changedTerms" || scenario === "changedTarget") {
        const outcome = await app.speak();
        await app.play(outcome.delivery);
        assert.equal(Object.values((await app.state()).actions)[0]?.status, "rejected");
      }
      if (scenario === "changedProviderTarget") {
        assert.deepEqual(Object.keys((await app.state()).actions), []);
        assert.ok(app.readCount > 0);
      }
      if (scenario === "noStaff") {
        assert.equal(app.authorityReads, 0);
        assert.equal(app.readCount, 0);
      }
      if (scenario === "wrongPatient" || scenario === "ambiguous") {
        assert.equal(app.readCount, 0);
        assert.deepEqual(Object.keys((await app.state()).actions), []);
      }
      if (scenario === "wrongCredential") assert.equal(app.readCount, 0);
      assert.equal(app.patchCount, 0);
      assert.equal(app.spoken.some(text => text.includes("is confirmed")), false);
      await app.close();
    }
  });

  test(`E2E-007/066 provider-backed ${kind} lost response reconciles without replay`, async () => {
    const app = await fixture(kind, "lostResponse");
    await app.begin();
    await app.play((await app.speak()).delivery);
    const uncertain = await app.speak();
    assert.equal(app.patchCount, 1);
    assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review.");
    await app.play(uncertain.delivery);
    const settled = await app.drain();
    assert.ok(settled.ok);
    assert.equal(Object.values(settled.value.actions)[0]?.status, "committed");
    assert.equal(app.patchCount, 1);
    await app.close();
  });

  test(`E2E-${kind === "cancel" ? "007" : "066"} ${kind} TCP reset after PATCH stays uncertain until exact observation`, async () => {
    let patches = 0;
    let readsAfterPatch = 0;
    let conflictReads = 0;
    let cancelled = false;
    let moved = false;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      if (request.method === "PATCH") {
        patches += 1;
        assert.equal(path, kind === "cancel" ? "/v1/individual_appointments/91/cancel"
          : "/v1/individual_appointments/91");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        if (kind === "cancel") cancelled = true;
        else {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          assert.deepEqual(body, { starts_at: newStart, ends_at: null });
          moved = true;
        }
        response.destroy();
        return;
      }
      assert.equal(request.method, "GET");
      if (path.endsWith("/conflicts")) {
        conflictReads += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ conflicts: { exist: false } }));
        return;
      }
      assert.equal(path, "/v1/individual_appointments/91");
      if (patches) readsAfterPatch += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "91", starts_at: moved ? newStart : oldStart,
        ends_at: moved ? "2026-10-08T12:30:00+07:00" : oldEnd,
        cancelled_at: cancelled ? now : null, archived_at: null, deleted_at: null,
        patient: { links: { self: `${base}/patients/42` } },
        business: { links: { self: `${base}/businesses/11` } },
        practitioner: { links: { self: `${base}/practitioners/22` } },
        appointment_type: { links: { self: `${base}/appointment_types/33` } },
        notes: "Private fixture note" }));
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
    let app: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      app = await fixture(kind, "success", "11", "synthetic-key-au5", providerFetch);
      await app.begin();
      await app.play((await app.speak()).delivery);
      const uncertain = await app.speak();
      assert.equal(patches, 1);
      assert.equal(readsAfterPatch, 0, "observation must follow the uncertain caller notice");
      assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review.");
      assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
      await app.play(uncertain.delivery);
      const settled = await app.drain();
      assert.ok(settled.ok);
      assert.equal(Object.values(settled.value.actions)[0]?.status, "committed");
      assert.ok(readsAfterPatch > 0);
      assert.equal(conflictReads, kind === "reschedule" ? 1 : 0);
      assert.equal(patches, 1, "exact observation cannot replay the PATCH");
      assert.equal(app.spoken.join(" ").includes("Private fixture note"), false);
    } finally {
      try { await app?.close(); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  });
}

test("E2E-007/066 current policy and emergency write stop prevent a provider PATCH", async () => {
  for (const kind of ["cancel", "reschedule"] as const) {
    for (const gate of ["policy", "writeStop"] as const) {
      const app = await fixture(kind, "success");
      await app.begin();
      await app.play((await app.speak()).delivery);
      if (gate === "policy") {
        assert.ok((await app.policy.changeAutomationEnabled(scope, "1", false, "clinic-admin")).ok);
      } else {
        assert.ok((await app.ledger.stopWrites(scope, "clinic-admin", "synthetic incident")).ok);
      }
      const outcome = await app.speak();
      assert.equal(app.patchCount, 0);
      assert.equal(app.spoken.some(text => text.includes("is confirmed")), false);
      await app.play(outcome.delivery);
      await app.close();
    }
  }
});

test("E2E-007/066 a provider writer bound to another business or credential cannot own the call", async () => {
  await assert.rejects(() => fixture("cancel", "success", "12"),
    /appointment change writer selection mismatch/);
  await assert.rejects(() => fixture("reschedule", "success", "11", "synthetic-rotated-key-au5"),
    /appointment change writer selection mismatch/);
});

test("E2E-066 a moved appointment with a conflict remains uncertain and is never replayed", async () => {
  const app = await fixture("reschedule", "moveConflict");
  await app.begin();
  await app.play((await app.speak()).delivery);
  const uncertain = await app.speak();
  assert.equal(app.patchCount, 1);
  assert.equal(app.conflictReads, 1);
  assert.equal(app.spoken.some(text => text.includes("move is confirmed")), false);
  await app.play(uncertain.delivery);
  app.clearConflict();
  const settled = await app.drain();
  assert.ok(settled.ok);
  assert.equal(app.patchCount, 1);
  assert.equal(app.conflictReads, 1, "a known conflicting move needs review even if a later read might clear");
  assert.notEqual(Object.values(settled.value.actions)[0]?.status, "committed");
  const due = "2026-10-01T10:05:00.000Z";
  assert.ok((await app.drain(due)).ok);
  const reviewed = await app.drain(due);
  assert.ok(reviewed.ok);
  assert.equal(Object.values(reviewed.value.actions)[0]?.status, "needsReview");
  assert.equal(app.staff.tasks(scope).length, 1);
  await app.close();
});

test("E2E-007/066 hangup after played details prevents either provider PATCH", async () => {
  for (const kind of ["cancel", "reschedule"] as const) {
    const app = await fixture(kind, "success");
    await app.begin();
    await app.play((await app.speak()).delivery);
    await app.close();
    await app.call.disconnect(now);
    assert.equal(app.callStops, 1);
    assert.equal(app.patchCount, 0);
  }
});

test("E2E-007/066 hangup during an in-flight PATCH releases the call without a confirmation or replay", async () => {
  for (const kind of ["cancel", "reschedule"] as const) {
    const app = await fixture(kind, "heldPatch");
    await app.begin();
    await app.play((await app.speak()).delivery);
    const speaking = app.speak().catch(() => undefined);
    await waitFor(() => app.patchCount === 1);
    try {
      const closed = await bounded(app.call.disconnect(now));
      assert.ok(closed.ok, closed.ok ? "" : closed.error.kind);
      await speaking;
      assert.equal(app.spoken.some(text => text.includes("is confirmed")), false);
      assert.equal(app.patchCount, 1);
    } finally {
      app.releasePatch();
      app.host.dispose();
    }
  }
});
