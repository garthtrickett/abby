import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TransientClinikoAppointmentChangeHost } from "../../src/standalone/transient-cliniko-appointment-change-host.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import { callIdFor } from "../../src/voice/admission.ts";

type Kind = "cancel" | "reschedule";
type Input = Readonly<{ kind: Kind; apiKey: string; contactEmail: string; businessId: string;
  practitionerId: string; appointmentTypeId: string; patientId: string; appointmentId: string;
  startsAt: string; endsAt: string; timeZone: string; markerToken: string; newStartsAt?: string }>;
const scope = { tenantId: "demo-voice-change", clinicId: "demo", locationId: "frontdesk" };
const idPattern = /^[1-9][0-9]{0,18}$/;

function inputFromStdin(): Input {
  if (process.env.ABBY_LIVE_CLINIKO_EVAL !== "1") throw new Error("live probe not enabled");
  const value = JSON.parse(readFileSync(0, "utf8")) as Input;
  if (!value || (value.kind !== "cancel" && value.kind !== "reschedule") ||
      ![value.businessId, value.practitionerId, value.appointmentTypeId, value.patientId,
        value.appointmentId].every(id => typeof id === "string" && idPattern.test(id)) ||
      typeof value.apiKey !== "string" || !/^[^\s]+-[a-z]{2}[0-9]+$/.test(value.apiKey) ||
      typeof value.contactEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.contactEmail) ||
      ![value.startsAt, value.endsAt].every(time => typeof time === "string" && Number.isFinite(Date.parse(time))) ||
      (value.kind === "reschedule" &&
        (typeof value.newStartsAt !== "string" || !Number.isFinite(Date.parse(value.newStartsAt)))) ||
      typeof value.markerToken !== "string" || !/^[a-f0-9-]{36}$/.test(value.markerToken) ||
      typeof value.timeZone !== "string") throw new Error("invalid live probe input");
  new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
  return value;
}

class ChangePolicyStore extends MemoryPolicyStore {
  private readonly kind: Kind;
  constructor(kind: Kind, now: string) {
    super("execute", () => now, async () => ok(true));
    this.kind = kind;
  }
  override async read(location: LocationScope) {
    const result = await super.read(location);
    return result.ok ? ok({ ...result.value, staffWorkEnabled: true,
      capabilities: { ...result.value.capabilities, [this.kind]: "execute" as const } }) : result;
  }
}

/** The owning Python fixture independently checks the mutation and archives patient and appointment. */
async function run(): Promise<void> {
  const input = inputFromStdin();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 4 * 60_000).toISOString();
  const event = { key: { accountRef: "synthetic-demo", providerCallRef: `change-${randomUUID()}` },
    dialedNumber: "+6125550199", presentedCallerNumber: "+61400111222", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session:${randomUUID()}`;
  const ledger = new MemoryLedger(async () => ok(true));
  const policy = new ChangePolicyStore(input.kind, now);
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
  const proof = new TransientPatientProofHost({ scope, callId, sessionId,
    presentedCallerNumber: event.presentedCallerNumber, policyVersion: "1", maxAttempts: 1,
    lookup: { async candidates() { return ok({ kind: "one" as const, candidateIds: [input.patientId] }); } },
    authority: { async attest(query) { return ok({ scope, callId, sessionId, patientId: input.patientId,
      policyVersion: query.policyVersion, operations: [query.operation] }); } },
    policy: { async current() { return ok({ scope, enabled: true, version: "1" }); } },
    clock: () => now,
  });
  let patchCount = 0;
  let postPatchTargetReads = 0;
  const provider: typeof fetch = (url, init) => {
    if (init?.method === "PATCH") patchCount += 1;
    if (patchCount && init?.method === "GET" &&
        new URL(String(url)).pathname.endsWith(`/individual_appointments/${input.appointmentId}`)) {
      postPatchTargetReads += 1;
    }
    return fetch(url, init);
  };
  const writer = { scope, apiKey: input.apiKey, contactEmail: input.contactEmail,
    businessId: input.businessId };
  const cancellation = ClinikoCancellationWriter.create(writer, provider, () => now);
  const rescheduling = ClinikoRescheduleWriter.create(writer, provider, () => now);
  assert.ok(cancellation.ok && rescheduling.ok);
  const staff = new ReferenceClinicHost([], []);
  const host = new TransientClinikoAppointmentChangeHost({ scope, callId, sessionId,
    policyVersion: "1", ledger, policy, proof, businessId: input.businessId,
    credentialFingerprint: clinikoCredentialFingerprint(input.apiKey),
    cancellation: cancellation.value, rescheduling: rescheduling.value, staff,
    authority: { async resolve(query) {
      assert.equal(query.patientId, input.patientId);
      const common = { scope, callId, sessionId, policyVersion: "1", patientId: input.patientId,
        targetRef: "selected-demo-appointment", businessId: input.businessId,
        practitionerId: input.practitionerId, appointmentTypeId: input.appointmentTypeId,
        credentialFingerprint: clinikoCredentialFingerprint(input.apiKey),
        target: { scope, appointmentRef: input.appointmentId, patientRef: input.patientId,
          startsAt: input.startsAt, endsAt: input.endsAt, timeZone: input.timeZone },
        terms: { version: "synthetic-demo-v1", approvedText:
          "This is a synthetic demo call. The clinic would confirm any applicable fee.", expiresAt } };
      return ok(input.kind === "cancel"
        ? { ...common, kind: "cancel" as const, cancellationReason: 50 as const }
        : { ...common, kind: "reschedule" as const,
          offer: { scope, offerRef: "selected-demo-time", serviceRef: "synthetic-demo",
            startsAt: input.newStartsAt!, expiresAt } });
    } }, clock: () => now,
  });
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef,
    dialedNumber: event.dialedNumber, routeVersion: "synthetic-demo-v1" }]);
  const chunks = new Map<string, number[]>();
  const spoken: string[] = [];
  let utterance = 0;
  let sequence = 0;
  let verificationRef = "no-proof";
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, routing, host,
    readiness: async () => ok(true), now: () => now, onCallStop: () => host.dispose(),
    resolveIntent: async turn => ok(turn.text === "Yes" ? { kind: "affirm" }
      : input.kind === "cancel"
        ? { kind: "cancel", verificationRef, targetRef: "selected-demo-appointment" }
        : { kind: "reschedule", verificationRef, targetRef: "selected-demo-appointment",
          offerRef: "selected-demo-time" }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      utterance += 1;
      return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: `caller-${utterance}`, text: utterance === 1 ? "Change my appointment" : "Yes",
        quality: "clear" }]);
    } },
    synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, index) {
      chunks.set(playbackId, [...(chunks.get(playbackId) ?? []), index]);
      return "queued" as const;
    }, async finishQueue() { return "queued" as const; }, async clear() { return true; } },
    mediaOptions: { silenceMs: 100 },
  });
  async function play(delivery: { kind: string; playbackId?: string }) {
    assert.equal(delivery.kind, "queued");
    assert.ok(delivery.playbackId);
    const played = await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId,
      lastSequence: chunks.get(delivery.playbackId)!.at(-1)!, status: "played" }, now);
    assert.ok(played.ok);
  }
  async function speak() {
    let result: Awaited<ReturnType<typeof call.acceptMedia>> | undefined;
    for (let frame = 0; frame < 7; frame += 1) {
      const bytes = new Uint8Array(640);
      if (frame < 2) {
        const view = new DataView(bytes.buffer);
        for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true);
      }
      result = await call.acceptMedia({ sessionId, sequence,
        capturedAt: new Date(Date.parse(now) + sequence * 20).toISOString(), bytes });
      sequence += 1;
      assert.ok(result.ok);
    }
    assert.ok(result?.ok && result.value.kind === "turnCompleted");
    return result.value.delivery;
  }
  try {
    const begun = await call.begin(now);
    assert.ok(begun.ok && begun.value.kind === "admitted");
    await play(begun.value.delivery);
    const issued = await proof.issue("syntheticHostTokenOne", input.kind === "cancel"
      ? "appointments.cancel" : "appointments.reschedule");
    assert.ok(issued.ok);
    verificationRef = issued.value.verificationRef;
    await play(await speak());
    assert.equal(patchCount, 0);
    assert.ok(spoken.at(-1)?.includes("clinic would confirm any applicable fee"));
    const outcome = await speak();
    const state = await ledger.read(callId, scope);
    assert.ok(state.ok);
    const action = Object.values(state.value.actions)[0];
    const committed = action?.status === "committed";
    assert.equal(patchCount, 1);
    assert.ok(committed && postPatchTargetReads > 0 && spoken.at(-1)?.includes("is confirmed"));
    assert.ok(spoken.every(text => !text.includes(input.markerToken)));
    await play(outcome);
    assert.ok(action);
    assert.equal((await host.write(action.mutation, now)).kind, "rejected");
    assert.equal(patchCount, 1);
    process.stdout.write(JSON.stringify({ ok: true, kind: input.kind, voiceCommitted: true,
      onePatch: true, confirmationAfterObservation: true, repeatRejected: true }));
  } finally {
    await call.disconnect(now);
    host.dispose();
  }
}

run().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, voiceCommitted: false, onePatch: false,
    confirmationAfterObservation: false, repeatRejected: false }));
  process.exitCode = 1;
});
