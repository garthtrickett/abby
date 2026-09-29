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
