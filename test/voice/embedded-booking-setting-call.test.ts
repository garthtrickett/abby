import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";

const now = "2026-09-29T10:00:00.000Z";
const scope = { tenantId: "booking-setting-voice", clinicId: "clinic", locationId: "main" };
const patient = { scope, patientRef: "synthetic-patient", verificationRef: "synthetic-proof",
  expiresAt: "2026-09-29T11:00:00.000Z" };
const offer = { scope, offerRef: "synthetic-offer", serviceRef: "physio",
  startsAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-09-29T11:00:00.000Z" };

function newCall(index: number, ledger: MemoryLedger, policy: MemoryPolicyStore,
  host: ReferenceClinicHost, routing: ReferenceNumberRoutingHost) {
  const event = { key: { accountRef: "buyer-provider", providerCallRef: `booking-setting-${index}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const sessionId = `booking-setting-session-${index}`;
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  let utterance = 0;
  let mediaSequence = 0;
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing,
    host, readiness: async () => ok(true),
    resolveIntent: async turn => ok(turn.text === "Book physio"
      ? { kind: "book", verificationRef: patient.verificationRef, offerRef: offer.offerRef }
      : { kind: "affirm" }),
    ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
      utterance += 1;
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text: utterance === 1 ? "Book physio" : "Yes", quality: "clear" }]);
    } } }),

    output: { async queueChunk(playbackId, sequence) {
      chunks.set(playbackId, [...(chunks.get(playbackId) ?? []), sequence]);
      return "queued" as const;
    }, async finishQueue() { return "queued" as const; }, async clear() { return true; } },
    mediaOptions: { silenceMs: 100 }, now: () => now,
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
    return completed.value;
  }
  return { call, event, spoken, play, speak };
}

test("E2E-010 embedded voice applies booking default, enabled and disabled to the next call", async () => {
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new ReferenceClinicHost([patient], [offer]);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: "buyer-provider",
    dialedNumber: "+6125550199", routeVersion: "host-route-v1" }]);


  const defaultOff = newCall(1, ledger, policy, host, routing);
  const defaultAdmission = await defaultOff.call.begin(now);
  assert.ok(defaultAdmission.ok);
  assert.equal(defaultAdmission.value.kind, "admitted");
  await defaultOff.play(defaultAdmission.value.delivery);
  const defaultTurn = await defaultOff.speak();
  await defaultOff.play(defaultTurn.delivery);
  assert.equal(host.bookings(scope).length, 0);
  assert.equal(defaultOff.spoken.at(-1), "I can't complete that request here.");
  const defaultState = await ledger.read(callIdFor(defaultOff.event.key), scope);
  assert.ok(defaultState.ok);
  assert.equal(defaultState.value.policy.capabilities.book, "unavailable");
  assert.equal(Object.keys(defaultState.value.actions).length, 0);
  await defaultOff.call.disconnect(now);

  const invalid = await policy.changeBookingEnabled(scope, "0", "yes" as unknown as boolean, "clinic-admin");
  assert.deepEqual(invalid, { ok: false, error: { kind: "invalidValue" } });
  const enabled = await policy.changeBookingEnabled(scope, "0", true, "clinic-admin");
  assert.ok(enabled.ok);
  const active = newCall(2, ledger, policy, host, routing);
  const activeAdmission = await active.call.begin(now);
  assert.ok(activeAdmission.ok);
  assert.equal(activeAdmission.value.kind, "admitted");
  await active.play(activeAdmission.value.delivery);

  const disabled = await policy.changeBookingEnabled(scope, "1", false, "clinic-admin");
  assert.ok(disabled.ok);
  const activeTurn = await active.speak();
  assert.match(active.spoken.at(-1) ?? "", /physio/i);
  assert.equal(host.bookings(scope).length, 0);
  await active.play(activeTurn.delivery);
  const affirmed = await active.speak();
  assert.equal(affirmed.turn.kind, "callerTurn");
  assert.equal(host.bookings(scope).length, 1);
  assert.equal(host.bookings(scope)[0]?.patientRef, patient.patientRef);
  assert.equal(active.spoken.at(-1), "Your booking is confirmed.");
  await active.play(affirmed.delivery);
  const activeState = await ledger.read(callIdFor(active.event.key), scope);
  assert.ok(activeState.ok);
  assert.equal(activeState.value.policy.capabilities.book, "execute");
  assert.equal(Object.values(activeState.value.actions)[0]?.status, "committed");
  await active.call.disconnect(now);

  const nextOff = newCall(3, ledger, policy, host, routing);
  const nextAdmission = await nextOff.call.begin(now);
  assert.ok(nextAdmission.ok);
  assert.equal(nextAdmission.value.kind, "admitted");
  await nextOff.play(nextAdmission.value.delivery);
  const nextTurn = await nextOff.speak();
  await nextOff.play(nextTurn.delivery);
  assert.equal(host.bookings(scope).length, 1, "the next call cannot make another booking");
  assert.equal(nextOff.spoken.at(-1), "I can't complete that request here.");
  const nextState = await ledger.read(callIdFor(nextOff.event.key), scope);
  assert.ok(nextState.ok);
  assert.equal(nextState.value.policy.capabilities.book, "unavailable");
  assert.equal(Object.keys(nextState.value.actions).length, 0);
  await nextOff.call.disconnect(now);
});

test("E2E-074 embedded voice stop and resume affect the next call without replaying a blocked booking", async () => {
  const ledger = new MemoryLedger(async () => ok(true));
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new ReferenceClinicHost([patient], [offer]);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: "buyer-provider",
    dialedNumber: "+6125550199", routeVersion: "host-route-v1" }]);
  const initialStop = await ledger.readWriteStop(scope);
  assert.ok(initialStop.ok);
  assert.deepEqual({ stopped: initialStop.value.stopped, version: initialStop.value.version },
    { stopped: false, version: "0" });

  const blocked = newCall(4, ledger, policy, host, routing);
  const admission = await blocked.call.begin(now);
  assert.ok(admission.ok && admission.value.kind === "admitted");
  await blocked.play(admission.value.delivery);
  const details = await blocked.speak();
  assert.match(blocked.spoken.at(-1) ?? "", /physio/i);
  await blocked.play(details.delivery);
  const stop = await ledger.stopWrites(scope, "clinic-admin", "Provider incident");
  assert.ok(stop.ok);
  assert.deepEqual({ stopped: stop.value.stopped, version: stop.value.version },
    { stopped: true, version: "1" });

  const denied = await blocked.speak();
  assert.equal(denied.turn.kind, "callerTurn");
  assert.equal(host.bookings(scope).length, 0);
  assert.match(blocked.spoken.at(-1) ?? "", /can't complete that action now/);
  assert.equal(blocked.spoken.some(text => text.includes("booking is confirmed")), false);
  await blocked.play(denied.delivery);
  const blockedState = await ledger.read(callIdFor(blocked.event.key), scope);
  assert.ok(blockedState.ok);
  assert.equal(Object.values(blockedState.value.actions)[0]?.status, "unsupported");

  const staleResume = await ledger.resumeWrites(scope, "0", "clinic-admin", "Stale tab");
  assert.deepEqual(staleResume, { ok: false, error: { kind: "versionConflict" } });
  const stillStopped = await ledger.readWriteStop(scope);
  assert.ok(stillStopped.ok);
  assert.equal(stillStopped.value.stopped, true);
  const resumed = await ledger.resumeWrites(scope, stop.value.version, "clinic-admin", "Provider recovered");
  assert.ok(resumed.ok);
  assert.deepEqual({ stopped: resumed.value.stopped, version: resumed.value.version },
    { stopped: false, version: "2" });
  assert.equal(host.bookings(scope).length, 0, "resume cannot replay the earlier blocked action");
  await blocked.call.disconnect(now);

  const next = newCall(5, ledger, policy, host, routing);
  const nextAdmission = await next.call.begin(now);
  assert.ok(nextAdmission.ok && nextAdmission.value.kind === "admitted");
  await next.play(nextAdmission.value.delivery);
  const nextDetails = await next.speak();
  await next.play(nextDetails.delivery);
  const confirmed = await next.speak();
  assert.equal(confirmed.turn.kind, "callerTurn");
  assert.equal(host.bookings(scope).length, 1);
  assert.equal(next.spoken.at(-1), "Your booking is confirmed.");
  await next.play(confirmed.delivery);
  const nextState = await ledger.read(callIdFor(next.event.key), scope);
  assert.ok(nextState.ok);
  assert.equal(Object.values(nextState.value.actions)[0]?.status, "committed");
  const previousAfterResume = await ledger.read(callIdFor(blocked.event.key), scope);
  assert.ok(previousAfterResume.ok);
  assert.equal(Object.values(previousAfterResume.value.actions)[0]?.status, "unsupported");
  await next.call.disconnect(now);
});
