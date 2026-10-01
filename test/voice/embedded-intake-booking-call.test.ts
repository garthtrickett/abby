import assert from "node:assert/strict";
import test from "node:test";
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
  constructor(bookingOutcome: "rejected" | "uncertain", expectedCallId: string, expectedSessionId: string,
              invalidConsent = false) {
    super([{ scope, patientRef: "created-patient-1", verificationRef: "created-proof-1",
      expiresAt: "2026-09-29T11:00:00.000Z" }], [offer]);
    this.bookingOutcome = bookingOutcome;
    this.expectedCallId = expectedCallId;
    this.expectedSessionId = expectedSessionId;
    this.invalidConsent = invalidConsent;
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
    return super.resolveBooking(location, verificationRef, offerRef, at);
  }

  override async write(mutation: HostMutation, at: string): Promise<HostWriteReceipt> {
    if (mutation.kind === "intake" && mutation.request.kind === "intake") {
      this.intakeWrites += 1;
      if (mutation.request.approvedDraftRef !== draftRef || mutation.payloadDigest !== digestActionRequest(mutation.request)) {
        return { kind: "rejected", actionKey: mutation.actionKey, reason: "invalid" };
      }
      this.createdRef = "created-patient-1";
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

async function runCall(bookingOutcome: "rejected" | "uncertain", invalidDraft = false, invalidConsent = false) {
  const event = { key: { accountRef: "buyer-provider", providerCallRef: `intake-${bookingOutcome}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session-${bookingOutcome}`;
  const ledger = new MemoryLedger();
  const policy = new IntakePolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new IntakeThenFailedBookingHost(bookingOutcome, callId, sessionId, invalidConsent);
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
