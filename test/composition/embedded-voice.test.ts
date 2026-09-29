import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";

test("E2E-144 embedded host supplies voice storage, settings, and media through the shared call flow", async () => {
  const now = "2026-09-29T10:00:00.000Z";
  const scope = { tenantId: "buyer", clinicId: "clinic", locationId: "main" };
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "host-admin")).ok);
  const host = new ReferenceClinicHost([], []);
  const event = { key: { accountRef: "buyer-provider", providerCallRef: "buyer-call" },
    dialedNumber: "+6125550199", presentedCallerNumber: "+6145550101", receivedAt: now };
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  const queued: Array<{ playbackId: string; sequence: number }> = [];
  let finishedPlayback: string | undefined;
  const call = createEmbeddedVoiceComposition({ event, sessionId: "buyer-session", ledger, policy, routing,
    host, readiness: async () => ok(true),
    resolveIntent: async () => ok({ kind: "handoff", reason: "callerRequested" }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      return ok([{ kind: "segmentFinal", sessionId: "buyer-session", generation,
        utteranceId: "caller-one", text: "Please speak with staff", quality: "clear" }]);
    } },
    synthesis: { async *stream() { yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, sequence) { queued.push({ playbackId, sequence }); return "queued"; },
      async finishQueue(playbackId) { finishedPlayback = playbackId; return "queued"; },
      async clear() { return true; } },
    mediaOptions: { silenceMs: 100 },
    now: () => now,
  });
  const started = await call.begin(now);
  assert.ok(started.ok);
  assert.equal(started.value.kind, "admitted");
  assert.equal(queued.length, 1);
  assert.equal(finishedPlayback, queued[0]?.playbackId);
  assert.ok(finishedPlayback);
  const played = await call.acceptPlaybackCompletion({ playbackId: finishedPlayback,
    lastSequence: 0, status: "played" }, now);
  assert.ok(played.ok);
  let completed = false;
  for (let index = 0; index < 7; index += 1) {
    const bytes = new Uint8Array(640);
    if (index < 2) {
      const view = new DataView(bytes.buffer);
      for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true);
    }
    const result = await call.acceptMedia({ sessionId: "buyer-session", sequence: index,
      capturedAt: new Date(Date.parse(now) + index * 20).toISOString(), bytes });
    assert.ok(result.ok, result.ok ? "" : result.error.kind);
    if (result.value.kind === "turnCompleted") completed = true;
  }
  assert.equal(completed, true);
  const state = await ledger.read(callIdFor(event.key), scope);
  assert.ok(state.ok);
  assert.equal(state.value.processedTurnIds.length, 1);
  assert.equal(state.value.policy.numberRouteVersion, "host-route-v1");
  assert.equal(Object.values(state.value.presentations)[0]?.status, "played");
  assert.equal(Object.keys(state.value.staffItems).length, 1);
  assert.equal(host.tasks(scope).length, 1);
  assert.equal(queued.length, 2);
  assert.ok((await call.disconnect(now)).ok);
});

test("E2E-145 embedded voice books only after exact details playback and a later affirmation", async () => {
  const now = "2026-09-29T10:00:00.000Z";
  const scope = { tenantId: "buyer-booking", clinicId: "clinic", locationId: "main" };
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "host-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "host-admin")).ok);
  const patient = { scope, patientRef: "host-patient", verificationRef: "host-verified",
    expiresAt: "2026-09-29T11:00:00.000Z" };
  const offer = { scope, offerRef: "host-offer", serviceRef: "physio",
    startsAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-09-29T11:00:00.000Z" };
  const host = new ReferenceClinicHost([patient], [offer]);
  const event = { key: { accountRef: "buyer-provider", providerCallRef: "buyer-booking-call" },
    dialedNumber: "+6125550199", receivedAt: now };
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  const queued: Array<{ playbackId: string; sequence: number }> = [];
  const utterances = ["Book physio", "Yes"];
  let nextUtterance = 0;
  const call = createEmbeddedVoiceComposition({ event, sessionId: "booking-session", ledger, policy, routing,
    host, readiness: async () => ok(true),
    resolveIntent: async turn => ok(turn.text === "Book physio"
      ? { kind: "book", verificationRef: "host-verified", offerRef: "host-offer" }
      : { kind: "affirm" }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      const text = utterances[nextUtterance++];
      assert.ok(text);
      return ok([{ kind: "segmentFinal", sessionId: "booking-session", generation,
        utteranceId: `caller-${nextUtterance}`, text, quality: "clear" }]);
    } },
    synthesis: { async *stream() { yield new Uint8Array(640); yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, sequence) { queued.push({ playbackId, sequence }); return "queued"; },
      async finishQueue() { return "queued"; }, async clear() { return true; } },
    mediaOptions: { silenceMs: 100 }, now: () => now,
  });
  const started = await call.begin(now);
  assert.ok(started.ok);
  assert.equal(started.value.kind, "admitted");
  if (started.value.kind !== "admitted" || started.value.delivery.kind !== "queued" ||
      !started.value.delivery.playbackId) throw new Error("greeting not queued");
  assert.equal(host.bookings(scope).length, 0);
  assert.ok((await call.acceptPlaybackCompletion({ playbackId: started.value.delivery.playbackId,
    lastSequence: 1, status: "played" }, now)).ok);
  let sequence = 0;
  async function speak() {
    let final: Awaited<ReturnType<typeof call.acceptMedia>> | undefined;
    for (let index = 0; index < 7; index += 1) {
      const bytes = new Uint8Array(640);
      if (index < 2) {
        const view = new DataView(bytes.buffer);
        for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true);
      }
      final = await call.acceptMedia({ sessionId: "booking-session", sequence,
        capturedAt: new Date(Date.parse(now) + sequence * 20).toISOString(), bytes });
      sequence += 1;
      assert.ok(final.ok, final.ok ? "" : final.error.kind);
    }
    assert.ok(final?.ok);
    if (final.value.kind !== "turnCompleted") throw new Error("caller turn not completed");
    return final.value;
  }
  const planned = await speak();
  assert.equal(planned.turn.kind, "callerTurn");
  assert.equal(planned.delivery.kind, "queued");
  assert.equal(host.bookings(scope).length, 0);
  if (planned.delivery.kind !== "queued" || !planned.delivery.playbackId) {
    throw new Error("booking details not queued");
  }
  assert.deepEqual(queued.filter(item => item.playbackId === planned.delivery.playbackId)
    .map(item => item.sequence), [0, 1]);
  const wrongCompletion = await call.acceptPlaybackCompletion({ playbackId: planned.delivery.playbackId,
    lastSequence: 0, status: "played" }, now);
  assert.deepEqual(wrongCompletion, { ok: false, error: { kind: "invalidPlaybackEvidence" } });
  assert.equal(host.bookings(scope).length, 0);
  assert.ok((await call.acceptPlaybackCompletion({ playbackId: planned.delivery.playbackId,
    lastSequence: 1, status: "played" }, now)).ok);
  const affirmed = await speak();
  assert.equal(affirmed.turn.kind, "callerTurn");
  const bookings = host.bookings(scope);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0]?.patientRef, patient.patientRef);
  assert.equal(bookings[0]?.offerRef, offer.offerRef);
  const state = await ledger.read(callIdFor(event.key), scope);
  assert.ok(state.ok);
  assert.equal(state.value.actions[bookings[0]!.actionKey]?.status, "committed");
  assert.ok((await call.disconnect(now)).ok);
  assert.equal(host.bookings(scope).length, 1);
});
