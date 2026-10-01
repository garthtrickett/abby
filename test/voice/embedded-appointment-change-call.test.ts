import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { digestActionRequest } from "../../src/core/digest.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation } from "../../src/core/model.ts";
import type { AppointmentChangeEvidenceQuery } from "../../src/core/host.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";

type Kind = "cancel" | "reschedule";
type Scenario = "success" | "wrongPatient" | "ambiguous" | "changedTarget" | "changedTerms" |
  "uncertain" | "requestOnly" | "unavailable" | "expiredTerms" | "missingTerms" | "expiredAfterConfirm";
const now = "2026-09-29T10:00:00.000Z";
const scope = { tenantId: "change-voice", clinicId: "clinic", locationId: "main" };
const patient = { scope, patientRef: "patient-one", verificationRef: "host-proof-one",
  expiresAt: "2026-09-29T11:00:00.000Z" };
const target = { scope, patientRef: patient.patientRef, appointmentRef: "appointment-one",
  startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z",
  timeZone: "Australia/Sydney" };
const offer = { scope, offerRef: "host-offer-one", serviceRef: "physio",
  startsAt: "2026-10-02T10:00:00.000Z", expiresAt: "2026-09-29T11:00:00.000Z" };

class ChangePolicyStore extends MemoryPolicyStore {
  private readonly kind: Kind;
  private readonly mode: "execute" | "requestOnly" | "unavailable";
  constructor(kind: Kind, mode: "execute" | "requestOnly" | "unavailable") {
    super("execute", () => now, async () => ok(true));
    this.kind = kind;
    this.mode = mode;
  }
  override async read(location: LocationScope) {
    const result = await super.read(location);
    return result.ok ? ok({ ...result.value, staffWorkEnabled: true,
      capabilities: { ...result.value.capabilities,
        [this.kind]: this.mode } }) : result;
  }
}

class ChangeHost extends ReferenceClinicHost {
  readonly kind: Kind;
  readonly callId: string;
  readonly sessionId: string;
  feeVersion = "fee-1";
  currentStart = target.startsAt;
  resolved = 0;
  hostWrites = 0;
  providerWrites = 0;
  reconciles = 0;
  uncertain = false;
  expiredTerms = false;
  missingTerms = false;
  termsExpiry = "2026-09-29T11:00:00.000Z";

  constructor(kind: Kind, callId: string, sessionId: string) {
    super([patient], [offer]);
    this.kind = kind;
    this.callId = callId;
    this.sessionId = sessionId;
  }

  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery) {
    this.resolved += 1;
    if (query.scope.tenantId !== scope.tenantId || query.scope.clinicId !== scope.clinicId ||
        query.scope.locationId !== scope.locationId || query.callId !== this.callId ||
        query.sessionId !== this.sessionId || query.policyVersion !== "1") {
      return err({ kind: "notFound" as const, target: "appointment" as const });
    }
    if (query.verificationRef !== patient.verificationRef) {
      return err({ kind: "notFound" as const, target: "patient" as const });
    }
    if (query.targetRef === "ambiguous-selection") {
      return err({ kind: "ambiguous" as const, target: "appointment" as const });
    }
    if (query.targetRef !== "selected-appointment-one" || query.kind !== this.kind ||
        (query.kind === "reschedule" && query.offerRef !== offer.offerRef)) {
      return err({ kind: "notFound" as const, target: "appointment" as const });
    }
    const terms = { version: this.feeVersion,
      approvedText: this.missingTerms ? "" : this.kind === "cancel"
        ? "No cancellation fee applies." : "No rescheduling fee applies.",
      expiresAt: this.expiredTerms ? now : this.termsExpiry };
    const request: Extract<ActionRequest, { kind: "cancel" | "reschedule" }> = this.kind === "cancel"
      ? { kind: "cancel", patient, target, terms }
      : { kind: "reschedule", patient, target, offer, terms };
    return ok(request);
  }

  override async write(mutation: HostMutation, at: string): Promise<HostWriteReceipt> {
    this.hostWrites += 1;
    const request = mutation.request;
    if (mutation.kind !== this.kind || request.kind !== this.kind ||
        mutation.scope.tenantId !== scope.tenantId || mutation.scope.clinicId !== scope.clinicId ||
        mutation.scope.locationId !== scope.locationId || mutation.policyVersion !== "1" ||
        mutation.payloadDigest !== digestActionRequest(request) ||
        request.patient.verificationRef !== patient.verificationRef ||
        request.target.appointmentRef !== target.appointmentRef ||
        request.target.patientRef !== patient.patientRef ||
        request.target.startsAt !== this.currentStart || request.terms.version !== this.feeVersion) {
      return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    }
    this.providerWrites += 1;
    if (this.uncertain) return { kind: "uncertain", actionKey: mutation.actionKey,
      reconcileAfter: at, deadline: "2026-09-29T10:10:00.000Z" };
    return { kind: "committed", actionKey: mutation.actionKey, hostRef: `${this.kind}:one` };
  }

  override async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    this.reconciles += 1;
    return { kind: "stillUnknown", actionKey: mutation.actionKey };
  }
}

async function run(kind: Kind, scenario: Scenario) {
  const event = { key: { accountRef: "buyer-provider", providerCallRef: randomUUID() },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session:${randomUUID()}`;
  const ledger = new MemoryLedger();
  const policy = new ChangePolicyStore(kind, scenario === "requestOnly" ? "requestOnly"
    : scenario === "unavailable" ? "unavailable" : "execute");
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const host = new ChangeHost(kind, callId, sessionId);
  host.uncertain = scenario === "uncertain";
  host.expiredTerms = scenario === "expiredTerms";
  host.missingTerms = scenario === "missingTerms";
  if (scenario === "expiredAfterConfirm") host.termsExpiry = "2026-09-29T10:00:01.000Z";
  let clock = now;
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "host-route-v1" }]);
  const turns = [kind === "cancel" ? "Cancel my appointment" : "Move my appointment", "Yes"];
  let utterance = 0;
  let mediaSequence = 0;
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host,
    readiness: async () => ok(true), now: () => clock,
    resolveIntent: async turn => {
      if (turn.text === "Yes") return ok({ kind: "affirm" });
      const verificationRef = scenario === "wrongPatient" ? "wrong-proof" : patient.verificationRef;
      const targetRef = scenario === "ambiguous" ? "ambiguous-selection" : "selected-appointment-one";
      return ok(kind === "cancel" ? { kind: "cancel", verificationRef, targetRef }
        : { kind: "reschedule", verificationRef, targetRef, offerRef: offer.offerRef });
    },
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      const text = turns[utterance++];
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
      lastSequence: sequences.at(-1)!, status: "played" }, clock);
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
        capturedAt: new Date(Date.parse(clock) + mediaSequence * 20).toISOString(), bytes });
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
  assert.equal(host.hostWrites, 0, "confirmation must finish playback before a write");
  let state = await ledger.read(callId, scope);
  assert.ok(state.ok);
  if (["wrongPatient", "ambiguous", "unavailable", "expiredTerms", "missingTerms"].includes(scenario)) {
    assert.deepEqual(Object.keys(state.value.actions), []);
    assert.equal(host.providerWrites, 0);
    assert.equal(spoken.some(text => text.includes("No cancellation fee") || text.includes("No rescheduling fee")), false);
    if (scenario === "unavailable") assert.equal(host.resolved, 0);
  } else if (scenario === "requestOnly") {
    assert.deepEqual(Object.keys(state.value.actions), []);
    assert.equal(host.providerWrites, 0);
    assert.match(spoken.at(-1) ?? "", /request staff follow-up/);
    const reception = createEmbeddedTextComposition(ledger, policy, host);
    assert.ok((await reception.drain(scope, callId, now)).ok);
    assert.equal(host.tasks(scope).length, 1);
  } else {
    const terms = kind === "cancel" ? "No cancellation fee applies." : "No rescheduling fee applies.";
    assert.ok(spoken.at(-1)?.includes(terms));
    assert.ok(spoken.at(-1)?.includes("1 October"));
    if (kind === "reschedule") assert.ok(spoken.at(-1)?.includes("2 October"));
    assert.equal(spoken.at(-1)?.includes(target.appointmentRef), false);
    if (scenario === "expiredAfterConfirm") clock = "2026-09-29T10:00:02.000Z";
    if (scenario === "changedTarget") host.currentStart = "2026-10-01T11:00:00.000Z";
    if (scenario === "changedTerms") host.feeVersion = "fee-2";
    await speak();
    state = await ledger.read(callId, scope);
    assert.ok(state.ok);
    const action = Object.values(state.value.actions)[0];
    assert.ok(action);
    assert.equal(host.hostWrites, scenario === "expiredAfterConfirm" ? 0 : 1);
    if (scenario === "success") {
      assert.equal(action.status, "committed");
      assert.equal(host.providerWrites, 1);
      assert.equal(spoken.at(-1), kind === "cancel"
        ? "Your appointment cancellation is confirmed." : "Your appointment move is confirmed.");
    } else if (scenario === "expiredAfterConfirm") {
      assert.equal(action.status, "canceled");
      assert.equal(host.providerWrites, 0);
      assert.match(spoken.at(-1) ?? "", /No change was made/);
    } else if (scenario === "uncertain") {
      assert.equal(action.status, "uncertain");
      assert.equal(host.providerWrites, 1);
      assert.equal(spoken.some(text => text.includes("is confirmed")), false);
      const reception = createEmbeddedTextComposition(ledger, policy, host);
      assert.ok((await reception.drain(scope, callId, "2026-09-29T10:10:00.000Z")).ok);
      assert.equal(host.reconciles, 1);
      assert.equal(host.providerWrites, 1);
      assert.ok((await reception.drain(scope, callId, "2026-09-29T10:10:00.000Z")).ok);
      assert.equal(host.tasks(scope).length, 1);
    } else {
      assert.equal(action.status, "rejected");
      assert.equal(host.providerWrites, 0);
      assert.equal(spoken.some(text => text.includes("is confirmed")), false);
    }
    const reception = createEmbeddedTextComposition(ledger, policy, host);
    assert.ok((await reception.drain(scope, callId, now)).ok);
    assert.equal(host.hostWrites, scenario === "expiredAfterConfirm" ? 0 : 1,
      "repeated effect delivery does not issue another host write");
  }
  await call.disconnect(clock);
}

test("E2E-007 embedded cancellation confirms exact time and fee before one committed write", () => run("cancel", "success"));
test("E2E-007 embedded cancellation denies wrong patient and ambiguous target", async () => {
  await run("cancel", "wrongPatient");
  await run("cancel", "ambiguous");
});
test("E2E-007 embedded cancellation rejects expired or missing fee wording and disabled mode", async () => {
  await run("cancel", "expiredTerms");
  await run("cancel", "missingTerms");
  await run("cancel", "unavailable");
});
test("E2E-007 embedded cancellation rejects changed target and changed fee terms", async () => {
  await run("cancel", "changedTarget");
  await run("cancel", "changedTerms");
});
test("E2E-007 embedded cancellation keeps an uncertain response visible without replay", () => run("cancel", "uncertain"));
test("E2E-007 embedded cancellation drops an expired confirmation before write", () => run("cancel", "expiredAfterConfirm"));
test("E2E-066 embedded rescheduling confirms old/new time and fee before one move", () => run("reschedule", "success"));
test("E2E-066 embedded rescheduling denies wrong patient and ambiguous target", async () => {
  await run("reschedule", "wrongPatient");
  await run("reschedule", "ambiguous");
});
test("E2E-066 embedded rescheduling rejects expired or missing fee wording and disabled mode", async () => {
  await run("reschedule", "expiredTerms");
  await run("reschedule", "missingTerms");
  await run("reschedule", "unavailable");
});
test("E2E-066 embedded rescheduling rejects changed target and changed fee terms", async () => {
  await run("reschedule", "changedTarget");
  await run("reschedule", "changedTerms");
});
test("E2E-066 embedded rescheduling keeps an uncertain response visible without replay", () => run("reschedule", "uncertain"));
test("E2E-066 embedded rescheduling drops an expired confirmation before write", () => run("reschedule", "expiredAfterConfirm"));
test("E2E-067 embedded request-only reschedule opens host task without a write", () => run("reschedule", "requestOnly"));
