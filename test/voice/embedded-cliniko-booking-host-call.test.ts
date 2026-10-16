import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TransientClinikoBookingHost } from "../../src/standalone/transient-cliniko-booking-host.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import { callIdFor } from "../../src/voice/admission.ts";

const now = "2026-10-01T10:00:00.000Z";
const scope = { tenantId: "synthetic-booking", clinicId: "clinic", locationId: "main" };
const sessionId = "synthetic-booking-session";
const offer = { scope, offerRef: "host-offer-1", serviceRef: "physiotherapy",
  startsAt: "2026-10-08T11:00:00.000Z", expiresAt: "2026-10-01T10:04:00.000Z" };
const base = "https://api.au5.cliniko.com/v1";

type Options = Readonly<{
  permit?: boolean;
  changedOfferAtCommit?: boolean;
  changedEndAtCommit?: boolean;
  revokeProofAtCommit?: boolean;
  stopDuringCommit?: boolean;
  provider?: "accepted" | "lostAfterCommit" | "failedBeforeCommit" | "conflict";
  providerFetch?: typeof fetch;
  conflictResults?: ReadonlyArray<"clear" | "present" | "malformed" | "unavailable">;
  holdConflictRead?: () => Promise<Response>;
  patientId?: string;
  offsetStart?: boolean;
  wrongSelection?: boolean;
}>;

async function fixture(options: Options = {}) {
  const event = { key: { accountRef: "host-provider", providerCallRef: `booking-${crypto.randomUUID()}` },
    dialedNumber: "+6125550199", presentedCallerNumber: "+61400111222", receivedAt: now };
  const callId = callIdFor(event.key);
  const ledger = new MemoryLedger(async () => ok(true));
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const proof = new TransientPatientProofHost({ scope, callId, sessionId,
    presentedCallerNumber: event.presentedCallerNumber, policyVersion: "1", maxAttempts: 2,
    lookup: { async candidates() { return ok({ kind: "one" as const, candidateIds: ["42"] }); } },
    authority: { async attest(query) { return ok({ scope, callId, sessionId,
      policyVersion: query.policyVersion, patientId: options.patientId ?? "42",
      operations: [query.operation] }); } },
    policy: { async current() { return ok({ scope, enabled: true, version: "1" }); } },
    clock: () => now,
  });
  const posts: Array<Record<string, unknown>> = [];
  let gets = 0;
  let conflictChecks = 0;
  let stored: Record<string, unknown> | undefined;
  const provider: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/conflicts")) {
      assert.equal(init?.method, "GET");
      assert.equal(new URL(String(input)).pathname, "/v1/individual_appointments/91/conflicts");
      const results = options.conflictResults ?? ["clear"];
      const result = results[Math.min(conflictChecks, results.length - 1)];
      conflictChecks += 1;
      if (options.holdConflictRead) return options.holdConflictRead();
      if (result === "unavailable") return new Response(null, { status: 503 });
      if (result === "malformed") return Response.json({ conflicts: { exist: "false" } });
      return Response.json({ conflicts: { exist: result === "present" },
        private_note: "provider-conflict-note-canary" });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      stored = { id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: body.ends_at,
        cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: `${base}/patients/42` } },
        business: { links: { self: `${base}/businesses/11` } },
        practitioner: { links: { self: `${base}/practitioners/22` } },
        appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      if (options.provider === "failedBeforeCommit") { stored = undefined; return new Response(null, { status: 503 }); }
      if (options.provider === "conflict") { stored = undefined; return new Response(null, { status: 409 }); }
      if (options.provider === "lostAfterCommit") throw new Error("synthetic response lost after commit");
      return Response.json(stored, { status: 201 });
    }
    assert.equal(init?.method, "GET");
    gets += 1;
    return Response.json({ total_entries: stored ? 1 : 0,
      individual_appointments: stored ? [stored] : [] });
  };
  const writer = ClinikoBookingWriter.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "dev@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  options.providerFetch ?? provider, () => now);
  assert.ok(writer.ok);
  let offerResolutions = 0;
  const host = new TransientClinikoBookingHost({ scope, callId, sessionId,
    policyVersion: "1", ledger, policy, proof, writer: writer.value,
    offers: { async resolve(query) {
      offerResolutions += 1;
      if (query.phase === "commit" && options.revokeProofAtCommit) proof.revoke();
      if (query.phase === "commit" && options.stopDuringCommit) {
        const stopped = await ledger.stopWrites(scope, "clinic-admin", "commit-time incident");
        assert.ok(stopped.ok);
      }
      const proposedOffer = options.offsetStart
        ? { ...offer, startsAt: "2026-10-08T18:00:00+07:00" } : offer;
      const currentOffer = query.phase === "commit" && options.changedOfferAtCommit
        ? { ...proposedOffer, startsAt: "2026-10-08T12:00:00.000Z" } : proposedOffer;
      return ok({ scope, callId, sessionId, policyVersion: "1", patientId: "42",
        businessId: "11", practitionerId: options.wrongSelection ? "99" : "22",
        appointmentTypeId: "33", endsAt: new Date(Date.parse(currentOffer.startsAt) +
          (query.phase === "commit" && options.changedEndAtCommit ? 60 : 30) * 60_000).toISOString(),
        offer: currentOffer, exclusiveCommitPermitted: options.permit !== false });
    } }, clock: () => now,
  });
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  let verificationRef = "unverified-ref";
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  let utterance = 0;
  let mediaSequence = 0;
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host,
    readiness: async () => ok(true), now: () => now,
    resolveIntent: async turn => ok(turn.text === "Book physiotherapy"
      ? { kind: "book", verificationRef, offerRef: offer.offerRef } : { kind: "affirm" }),
    ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
      utterance += 1;
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text: utterance === 1 ? "Book physiotherapy" : "Yes",
        quality: "clear" }]);
    } } }),

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
      if (!completed.ok) {
        const state = await ledger.read(callId, scope);
        throw new Error(JSON.stringify({ failure: completed.error.kind,
          actions: state.ok ? Object.values(state.value.actions).map(item => item.status) : [],
          presentations: state.ok ? Object.values(state.value.presentations).map(item => item.status) : [],
          spoken, offerResolutions }));
      }
    }
    assert.ok(completed?.ok);
    assert.equal(completed.value.kind, "turnCompleted");
    return completed.value;
  }
  async function begin(issueProof = true) {
    const started = await call.begin(now);
    assert.ok(started.ok && started.value.kind === "admitted");
    await play(started.value.delivery);
    if (issueProof) {
      const issued = await proof.issue("syntheticHostTokenOne", "appointments.book");
      if (options.patientId === "99") assert.deepEqual(issued, { ok: false, error: { kind: "denied" } });
      else {
        assert.ok(issued.ok, issued.ok ? "" : issued.error.kind);
        verificationRef = issued.value.verificationRef;
      }
    }
  }
  return { begin, play, speak, call, host, proof, policy, ledger, callId, spoken, posts,
    get verificationRef() { return verificationRef; },
    get gets() { return gets; }, get conflictChecks() { return conflictChecks; }, get offerResolutions() { return offerResolutions; },
    state: async () => {
      const read = await ledger.read(callId, scope);
      assert.ok(read.ok);
      return read.value;
    },
    drain: async () => createEmbeddedTextComposition(ledger, policy, host).drain(scope, callId, now),
    close: async () => { await call.disconnect(now); host.dispose(); },
  };
}

test("E2E-226 call-bound proof, exclusive offer and played confirmation permit one exact Cliniko POST", async () => {
  const app = await fixture();
  await app.begin();
  const details = await app.speak();
  assert.equal(app.posts.length, 0);
  assert.match(app.spoken.at(-1) ?? "", /physiotherapy/);
  await app.play(details.delivery);
  const affirmed = await app.speak();
  assert.equal(app.posts.length, 1);
  assert.equal(app.posts[0]?.patient_id, "42");
  assert.equal(app.posts[0]?.starts_at, offer.startsAt);
  assert.equal(app.offerResolutions, 2);
  assert.equal(app.spoken.at(-1), "Your booking is confirmed.");
  const action = Object.values((await app.state()).actions)[0];
  assert.equal(action?.status, "committed");
  assert.ok(action);
  assert.deepEqual(await app.host.reconcile(action.mutation),
    { kind: "stillUnknown", actionKey: action.key });
  assert.equal(app.gets, 0, "a committed call does not authorize a redundant patient observation");
  await app.play(affirmed.delivery);
  await app.close();
});

test("E2E-226 a host-issued time with an explicit clinic offset survives exact receipt matching", async () => {
  const app = await fixture({ offsetStart: true });
  await app.begin();
  await app.play((await app.speak()).delivery);
  const affirmed = await app.speak();
  assert.equal(app.posts.length, 1);
  assert.equal(app.posts[0]?.starts_at, "2026-10-08T18:00:00+07:00");
  assert.equal(app.spoken.at(-1), "Your booking is confirmed.");
  await app.play(affirmed.delivery);
  await app.close();
});

test("E2E-226 foreign-call proof and unplayed details cannot authorize a booking write", async () => {
  const first = await fixture();
  const second = await fixture();
  await first.begin();
  await second.begin();
  const foreign = await second.host.resolveBooking(scope, first.verificationRef, offer.offerRef, now);
  assert.equal(foreign.ok, false);
  assert.equal(second.offerResolutions, 0);
  assert.equal(second.posts.length, 0);
  await second.close();

  const details = await first.speak();
  const action = Object.values((await first.state()).actions)[0];
  assert.ok(action);
  assert.equal(first.posts.length, 0);
  const direct = await first.host.write(action.mutation, now);
  assert.deepEqual(direct, { kind: "rejected", actionKey: action.key, reason: "forbidden" });
  assert.equal(first.posts.length, 0);
  await first.play(details.delivery);
  const affirmed = await first.speak();
  assert.equal(first.posts.length, 0, "a direct premature attempt consumes this call's send permit");
  assert.equal(first.spoken.some(text => text.includes("booking is confirmed")), false);
  await first.play(affirmed.delivery);
  await first.close();
});

test("E2E-226 emergency write stop and hangup before confirmation send no Cliniko POST", async () => {
  const stopped = await fixture();
  await stopped.begin();
  await stopped.play((await stopped.speak()).delivery);
  const stop = await stopped.ledger.stopWrites(scope, "clinic-admin", "synthetic incident");
  assert.ok(stop.ok);
  const blocked = await stopped.speak();
  assert.equal(stopped.posts.length, 0);
  assert.equal(stopped.spoken.some(text => text.includes("booking is confirmed")), false);
  await stopped.play(blocked.delivery);
  await stopped.close();

  const hungUp = await fixture();
  await hungUp.begin();
  await hungUp.play((await hungUp.speak()).delivery);
  await hungUp.close();
  assert.equal(hungUp.posts.length, 0);
});

test("E2E-226 wrong proof, missing permit or mismatched writer selection make no booking POST", async () => {
  for (const options of [{ issueProof: false }, { patientId: "99" }, { permit: false },
    { wrongSelection: true }]) {
    const app = await fixture(options);
    await app.begin(options.issueProof !== false);
    const response = await app.speak();
    assert.equal(app.posts.length, 0);
    assert.deepEqual(Object.keys((await app.state()).actions), []);
    assert.equal(app.spoken.some(text => text.includes("booking is confirmed")), false);
    await app.play(response.delivery);
    await app.close();
  }
});

test("E2E-226 current policy, offer, proof or write stop blocks a previously played booking", async () => {
  for (const change of ["policy", "offer", "duration", "proof", "stop"] as const) {
    const app = await fixture({ changedOfferAtCommit: change === "offer",
      changedEndAtCommit: change === "duration",
      revokeProofAtCommit: change === "proof", stopDuringCommit: change === "stop" });
    await app.begin();
    const details = await app.speak();
    await app.play(details.delivery);
    if (change === "policy") {
      const disabled = await app.policy.changeBookingEnabled(scope, "1", false, "clinic-admin");
      assert.ok(disabled.ok);
    }
    const affirmed = await app.speak();
    assert.equal(app.posts.length, 0, `${change} must stop before Cliniko POST`);
    assert.equal(app.spoken.some(text => text.includes("booking is confirmed")), false);
    assert.equal(Object.values((await app.state()).actions)[0]?.status, "rejected");
    await app.play(affirmed.delivery);
    await app.close();
  }
});

test("E2E-226 lost response after commit permits exact observation but no second POST", async () => {
  const app = await fixture({ provider: "lostAfterCommit" });
  await app.begin();
  await app.play((await app.speak()).delivery);
  const uncertain = await app.speak();
  assert.equal(app.posts.length, 1);
  assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.");
  await app.play(uncertain.delivery);
  const settled = await app.drain();
  assert.ok(settled.ok);
  assert.equal(app.gets, 1);
  assert.equal(app.posts.length, 1);
  assert.equal(Object.values(settled.value.actions)[0]?.status, "committed");
  await app.close();
});

test("E2E-226 a TCP reset after provider commit stays uncertain until exact observation", async () => {
  let posts = 0;
  let gets = 0;
  let conflictChecks = 0;
  let stored: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/individual_appointments/91/conflicts") {
      assert.equal(request.method, "GET");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ conflicts: { exist: false } }));
      return;
    }
    assert.equal(request.url?.split("?")[0], "/v1/individual_appointments");
    if (request.method === "POST") {
      posts += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      stored = { id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: body.ends_at,
        cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } },
        business: { links: { self: `${base}/businesses/${body.business_id}` } },
        practitioner: { links: { self: `${base}/practitioners/${body.practitioner_id}` } },
        appointment_type: { links: { self: `${base}/appointment_types/${body.appointment_type_id}` } } };
      response.destroy();
      return;
    }
    assert.equal(request.method, "GET");
    gets += 1;
    assert.deepEqual(new URL(request.url!, "http://localhost").searchParams.getAll("q[]"), ["patient_id:=42"]);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ total_entries: stored ? 1 : 0,
      individual_appointments: stored ? [stored] : [] }));
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
    app = await fixture({ providerFetch });
    await app.begin();
    await app.play((await app.speak()).delivery);
    const uncertain = await app.speak();
    assert.equal(posts, 1);
    assert.equal(gets, 0);
    assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.");
    assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
    await app.play(uncertain.delivery);
    const settled = await app.drain();
    assert.ok(settled.ok);
    assert.equal(gets, 1);
    assert.equal(posts, 1, "exact observation cannot replay the committed POST");
    assert.equal(Object.values(settled.value.actions)[0]?.status, "committed");
  } finally {
    try { await app?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});

test("E2E-226 turning booking off after an uncertain send still permits proof-checked exact observation", async () => {
  const app = await fixture({ provider: "lostAfterCommit" });
  await app.begin();
  await app.play((await app.speak()).delivery);
  const uncertain = await app.speak();
  assert.equal(app.posts.length, 1);
  const disabled = await app.policy.changeBookingEnabled(scope, "1", false, "clinic-admin");
  assert.ok(disabled.ok);
  await app.play(uncertain.delivery);
  const settled = await app.drain();
  assert.ok(settled.ok);
  assert.equal(app.gets, 1);
  assert.equal(app.posts.length, 1);
  assert.equal(Object.values(settled.value.actions)[0]?.status, "committed");
  await app.close();
});

test("E2E-226 a 409 or 503 never turns an empty observation into a retry", async () => {
  for (const provider of ["conflict", "failedBeforeCommit"] as const) {
    const app = await fixture({ provider });
    await app.begin();
    await app.play((await app.speak()).delivery);
    const uncertain = await app.speak();
    assert.equal(app.posts.length, 1);
    await app.play(uncertain.delivery);
    const settled = await app.drain();
    assert.ok(settled.ok);
    assert.equal(app.gets, 1);
    assert.equal(app.posts.length, 1);
    assert.notEqual(Object.values(settled.value.actions)[0]?.status, "committed");
    await app.close();
  }
});


test("E2E-266 confirmed booking requires a successful provider conflict read", async () => {
  const app = await fixture();
  try {
    await app.begin();
    await app.play((await app.speak()).delivery);
    await app.play((await app.speak()).delivery);
    assert.equal(app.posts.length, 1);
    assert.equal(app.conflictChecks, 1);
    assert.equal(app.spoken.at(-1), "Your booking is confirmed.");
    assert.equal(Object.values((await app.state()).actions)[0]?.status, "committed");
    assert.doesNotMatch(JSON.stringify({ spoken: app.spoken, state: await app.state() }),
      /provider-conflict-note-canary/);
  } finally { await app.close(); }
});

test("E2E-266 conflict-read errors stay uncertain and recover only by observation, never another write", async () => {
  for (const failure of ["unavailable", "malformed"] as const) {
    const app = await fixture({ conflictResults: [failure, failure, "clear"] });
    try {
      await app.begin();
      await app.play((await app.speak()).delivery);
      const pending = await app.speak();
      assert.equal(app.posts.length, 1);
      assert.equal(app.conflictChecks, 1);
      assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.");
      assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
      await app.play(pending.delivery);
      assert.ok((await app.drain()).ok);
      assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
      assert.ok((await app.drain()).ok);
      assert.equal(Object.values((await app.state()).actions)[0]?.status, "committed");
      assert.equal(app.conflictChecks, 3);
      assert.equal(app.posts.length, 1);
      assert.equal(app.gets, 2);
    } finally { await app.close(); }
  }
});

test("E2E-266 a detected conflict cannot later become confirmed or trigger compensation", async () => {
  for (const provider of ["accepted", "lostAfterCommit"] as const) {
    const app = await fixture({ provider, conflictResults: ["present", "clear"] });
    try {
      await app.begin();
      await app.play((await app.speak()).delivery);
      const pending = await app.speak();
      assert.equal(app.spoken.at(-1), "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.");
      await app.play(pending.delivery);
      assert.ok((await app.drain()).ok);
      assert.ok((await app.drain()).ok);
      assert.equal(app.conflictChecks, 1, "a known conflicting attempt cannot be silently upgraded later");
      assert.equal(app.posts.length, 1);
      assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
      assert.ok(!app.spoken.includes("Your booking is confirmed."));
      assert.doesNotMatch(JSON.stringify({ spoken: app.spoken, state: await app.state() }),
        /provider-conflict-note-canary/);
    } finally { await app.close(); }
  }
});


test("E2E-266 closing the host during a held conflict read cannot confirm a late clear response", { timeout: 5_000 }, async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let release!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  const app = await fixture({ holdConflictRead: async () => { began(); return response; } });
  try {
    await app.begin();
    await app.play((await app.speak()).delivery);
    const pending = app.speak();
    await started;
    assert.equal(app.posts.length, 1);
    assert.equal(app.conflictChecks, 1);
    app.host.dispose();
    const unresolved = await pending;
    assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
    assert.ok(!app.spoken.includes("Your booking is confirmed."));
    release(Response.json({ conflicts: { exist: false } }));
    await app.play(unresolved.delivery);
    assert.ok((await app.drain()).ok);
    assert.equal(app.posts.length, 1);
    assert.equal(Object.values((await app.state()).actions)[0]?.status, "uncertain");
  } finally { release(Response.json({ conflicts: { exist: false } })); await app.close(); }
});
