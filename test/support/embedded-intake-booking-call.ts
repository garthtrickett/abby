import { syntheticSpeech, withApprovedSyntheticVoice } from "./approved-voice.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digestActionRequest } from "../../src/core/digest.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import { err, ok } from "../../src/core/model.ts";
import type { IntakeEvidenceQuery, PolicyStore } from "../../src/core/host.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";

export const now = "2026-09-29T10:00:00.000Z";
export const scope = { tenantId: "intake-voice", clinicId: "clinic", locationId: "main" };
export const draftRef = "approved-draft-1";
const offer = { scope, offerRef: "offer-1", serviceRef: "physio",
  startsAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-09-29T11:00:00.000Z" };

class IntakePolicyStore extends MemoryPolicyStore {
  override async read(location: LocationScope) {
    const read = await super.read(location);
    return read.ok ? ok({ ...read.value, staffWorkEnabled: true,
      capabilities: read.value.capabilities }) : read;
  }
}

class IntakeThenFailedBookingHost extends ReferenceClinicHost {
  createdRef: string | undefined;
  intakeWrites = 0;
  intakeReads = 0;
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
    this.intakeReads += 1;
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
      assert.equal(mutation.request.consentRef, "host-consent-1");
      assert.equal(mutation.request.duplicateCheckRef, "host-duplicate-check-1");
      assert.deepEqual(mutation.request.scope, scope);
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

type IntakeCallFixture = Readonly<{ ledger: LedgerStore & EffectCallLeaseStore; policy: PolicyStore;
  expected: Readonly<{ enabled: boolean; version: string; mode: "execute" | "unavailable" }>;
  afterAdmission?: () => Promise<void> }>;

export async function runEmbeddedIntakeBookingCall(bookingOutcome: "rejected" | "uncertain", invalidDraft = false,
                       invalidConsent = false, createPatient?: () => Promise<string | undefined>,
                       uncertainIntake = false, configured?: IntakeCallFixture) {
  const event = { key: { accountRef: "buyer-provider", providerCallRef: configured ? `intake-setting-${randomUUID()}` : `intake-${bookingOutcome}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session-${bookingOutcome}`;
  const ledger = configured?.ledger ?? new MemoryLedger();
  const policy = withApprovedSyntheticVoice(configured?.policy ?? new IntakePolicyStore("execute", () => now, async () => ok(true), { intake: "execute" }));
  if (!configured) {
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
    assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
    assert.ok((await policy.changeFirstTimeIntakeEnabled(scope, "0", true, "clinic-admin")).ok);
  }
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
    ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
      const text = callerTurns[utterance++];
      assert.ok(text);
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text, quality: "clear" }]);
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
    const result = await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId,
      lastSequence: sequences.at(-1)!, status: "played" }, now);
    assert.ok(result.ok);
  }

  async function speak(expectedFailure?: "confirmationMissing") {
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
      if (expectedFailure && !completed.ok) {
        assert.equal(completed.error.kind, expectedFailure);
        return;
      }
      assert.ok(completed.ok, completed.ok ? "" : completed.error.kind);
    }
    assert.ok(completed?.ok);
    assert.equal(expectedFailure, undefined, "an unrequested confirmation must be rejected");
    assert.equal(completed.value.kind, "turnCompleted");
    await play(completed.value.delivery);
  }

  const started = await call.begin(now);
  assert.ok(started.ok);
  assert.equal(started.value.kind, "admitted");
  await play(started.value.delivery);
  if (configured) {
    const captured = await ledger.read(callId, scope);
    assert.ok(captured.ok);
    assert.equal(captured.value.policy.firstTimeIntakeEnabled, configured.expected.enabled);
    assert.equal(captured.value.policy.firstTimeIntakeVersion, configured.expected.version);
    assert.equal(captured.value.policy.capabilities.intake, configured.expected.mode);
    await configured.afterAdmission?.();
  }
  await speak();
  assert.equal(host.intakeWrites, 0, "the intake confirmation must be played before a write");
  if (configured?.expected.mode === "unavailable") {
    assert.equal(spoken.at(-1), "I can't complete that request here.");
    await speak("confirmationMissing");
    const state = await ledger.read(callId, scope);
    assert.ok(state.ok);
    assert.deepEqual(Object.keys(state.value.actions), []);
    assert.equal(host.intakeReads, 0);
    assert.equal(host.intakeWrites, 0);
    assert.equal(host.bookingWrites, 0);
    assert.equal(spoken.includes("Your details were saved. No appointment is confirmed yet."), false);
    await call.disconnect(now);
    return;
  }
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
  assert.equal(spoken.at(-1), "Please confirm that your approved intake details may be saved. This does not book an appointment.");
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
