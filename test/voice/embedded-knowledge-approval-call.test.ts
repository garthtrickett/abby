import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";

const now = "2026-09-28T10:00:00.000Z";
const scope = { tenantId: "knowledge-voice", clinicId: "clinic", locationId: "main" };
const approvedText = "Parking is behind the clinic.";
const unavailableText = "I can't verify that information right now.";

test("E2E-004 embedded voice speaks only currently approved, call-pinned clinic knowledge", async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new ReferenceClinicHost([], []);
  const knowledge = new MemoryKnowledgeCatalogue();
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: "buyer-provider",
    dialedNumber: "+6125550199", routeVersion: "host-route-v1" }]);

  function newCall(index: number) {
    const event = { key: { accountRef: "buyer-provider", providerCallRef: `knowledge-${index}` },
      dialedNumber: "+6125550199", receivedAt: now };
    const sessionId = `knowledge-session-${index}`;
    const spoken: string[] = [];
    const chunks = new Map<string, number[]>();
    let utterance = 0;
    let mediaSequence = 0;
    const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host, knowledge,
      readiness: async () => ok(true),
      resolveIntent: async () => ok({ kind: "answer", sourceRefs: ["parking"], proposedText: approvedText }),
      transcription: { async accept() { return ok([]); }, async flush(generation) {
        utterance += 1;
        return ok([{ kind: "segmentFinal", sessionId, generation,
          utteranceId: `parking-${utterance}`, text: "Where is parking?", quality: "clear" }]);
      } },
      synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
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
    async function begin() {
      const started = await call.begin(now);
      assert.ok(started.ok);
      assert.equal(started.value.kind, "admitted");
      await play(started.value.delivery);
    }
    async function answer() {
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
      const state = await ledger.read(callIdFor(event.key), scope);
      assert.ok(state.ok);
      return state.value;
    }
    return { call, spoken, begin, answer };
  }

  const beforeApproval = newCall(1);
  await beforeApproval.begin();
  const draft = await knowledge.saveDraft(scope, "parking", "0", "practice-manager", approvedText,
    "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "clinic-admin");
  assert.ok(draft.ok);
  const draftAnswer = await beforeApproval.answer();
  assert.deepEqual(draftAnswer.policy.knowledgeSnapshot, []);
  assert.equal(beforeApproval.spoken.at(-1), unavailableText);
  assert.equal(draftAnswer.knowledgeAnswers.length, 0);

  const draftOnly = newCall(4);
  await draftOnly.begin();
  const draftOnlyAnswer = await draftOnly.answer();
  assert.deepEqual(draftOnlyAnswer.policy.knowledgeSnapshot, []);
  assert.equal(draftOnly.spoken.at(-1), unavailableText);
  assert.equal(draftOnlyAnswer.knowledgeAnswers.length, 0);

  assert.deepEqual(await knowledge.approve(scope, "parking", "0", "clinic-admin"),
    { ok: false, error: { kind: "versionConflict" } });
  const approved = await knowledge.approve(scope, "parking", draft.value.version, "clinic-admin");
  assert.ok(approved.ok);
  assert.equal(approved.value.version, "2");
  const oldCallAnswer = await beforeApproval.answer();
  assert.equal(beforeApproval.spoken.at(-1), unavailableText);
  assert.equal(oldCallAnswer.knowledgeAnswers.length, 0);
  await beforeApproval.call.disconnect(now);
  const stillDraftOnly = await draftOnly.answer();
  assert.equal(draftOnly.spoken.at(-1), unavailableText);
  assert.equal(stillDraftOnly.knowledgeAnswers.length, 0);
  await draftOnly.call.disconnect(now);

  const current = newCall(2);
  await current.begin();
  const sourced = await current.answer();
  assert.equal(current.spoken.at(-1), approvedText);
  assert.deepEqual(sourced.policy.knowledgeSnapshot, [{ sourceRef: "parking", version: "2" }]);
  assert.equal(sourced.knowledgeAnswers.length, 1);
  assert.match(sourced.knowledgeAnswers[0]!.turnId, /^[a-f0-9]{64}$/);
  assert.equal(sourced.knowledgeAnswers[0]!.sourceRef, "parking");
  assert.equal(sourced.knowledgeAnswers[0]!.version, "2");
  assert.equal(sourced.knowledgeAnswers[0]!.ownerRef, "practice-manager");
  assert.equal(host.bookings(scope).length, 0);
  assert.equal(Object.keys(sourced.actions).length, 0);

  const revoked = await knowledge.revoke(scope, "parking", "2", "clinic-admin");
  assert.ok(revoked.ok);
  const afterRevocation = await current.answer();
  assert.equal(current.spoken.at(-1), unavailableText);
  assert.equal(afterRevocation.knowledgeAnswers.length, 1, "revocation does not rewrite prior answer evidence");
  await current.call.disconnect(now);

  const next = newCall(3);
  await next.begin();
  const unavailable = await next.answer();
  assert.equal(next.spoken.at(-1), unavailableText);
  assert.deepEqual(unavailable.policy.knowledgeSnapshot, []);
  assert.equal(unavailable.knowledgeAnswers.length, 0);
  assert.equal(host.bookings(scope).length, 0);
  await next.call.disconnect(now);
});
