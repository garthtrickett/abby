import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CallRuntime } from "../../src/core/runtime.ts";
import type { FinalCallerTurn } from "../../src/core/model.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { ClinikoOutboundClinicalContext } from "../../src/standalone/cliniko-outbound-clinical-context.ts";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import { ClinikoOutboundAppointmentTarget } from "../../src/cliniko/outbound-appointment-target.ts";
import type { OutboundTargetQuery } from "../../src/cliniko/outbound-appointment-target.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { cancellationSessionFixture } from "./cancellation-session.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { value } from "./outbound-records.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Actual native decoder, caller OTP/proof, exact selection, played SAM,
 * review and one-shot mutation. Remote native transport/grants are synthetic. */
export async function outboundClinicalCancellationFixture(options: Readonly<{ budget?: ClinikoRequestBudget; apiKey?: string; recipientNumber?: string; lostWrite?: boolean }> = {}) {
  const f = await cancellationSessionFixture({ multiple: true, ...(options.budget ? { rateBudget: options.budget } : {}) });
  f.owner.dispose();
  const lifetime = new AbortController();
  let patches = 0, cancelled = false;
  let lastTarget: Record<string, unknown> | undefined;
  try {
    const recipientNumber = options.recipientNumber ?? "+61481937526";
    let contactNumber = recipientNumber;
    const base = "https://api.au5.cliniko.com/v1", c = { ...f.config.cliniko, ...(options.apiKey ? { apiKey: options.apiKey } : {}) };
    if (options.apiKey) {
      await f.replaceCancellation({ credentialFingerprint: clinikoCredentialFingerprint(c.apiKey) });
    }
    const requests = { scope: f.scope, apiKey: c.apiKey, contactEmail: c.contactEmail, businessId: c.businessId,
      outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), rateBudget: c.rateBudget, clock: () => verificationNow };
    const state = { live: true, targetLive: true, targetAllowed: true, nativeLive: true, targetVersion: "2026-10-02T00:00:00.000Z", targetReads: 0,
      beforeTarget: undefined as undefined | (() => void | Promise<void>),
      beforeTargetApproval: undefined as undefined | ((query: OutboundTargetQuery) => void | Promise<void>) };
    let notes = "", requestUpdatedAt = verificationNow;
    const nativeCalls: { path: string; method: string }[] = [];
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET"; nativeCalls.push({ path: url.pathname, method });
      if (url.pathname === "/v1/recalls/30" && method === "GET") return Response.json({ id: "30", links: { self: `${base}/recalls/30` },
        patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: `${base}/recall_types/61` } },
        notes, recall_at: "2026-10-05", recalled: false, recalled_at: null, archived_at: null, created_at: verificationNow, updated_at: requestUpdatedAt });
      if (url.pathname === "/v1/individual_appointments/91/cancel" && method === "PATCH") {
        const current = await currentState(), action = Object.values(current.actions)[0]!;
        assert.equal(action.status, "dispatched");
        assert.equal(current.presentations[action.presentationId]?.status, "played");
        assert.equal(f.recalls.length, 1);
        assert.deepEqual(JSON.parse(String(init?.body)), { cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false });
        const review = value(decodeClinikoReview(f.recalls[0]!.notes));
        assert.equal(review.request.operation.kind, "cancel");
        if (review.request.operation.kind !== "cancel") throw Error("Expected exact cancellation review");
        assert.equal(review.request.operation.appointmentId, "91");
        assert.equal(review.request.patientId, verificationCanaries[2]);
        assert.deepEqual([review.request.operation.startsAt, review.request.operation.endsAt],
          ["2026-10-08T04:00:00.000Z", "2026-10-08T04:30:00.000Z"]);
        assert.ok(lastTarget); assert.equal(patches, 0); patches++; cancelled = true;
        if (options.lostWrite) throw Error("Synthetic cancellation acknowledgement lost after one native send");
        return new Response(null, { status: 204 });
      }
      const response = await f.config.fetchPort!(input, init);
      if (url.pathname === `/v1/patients/${verificationCanaries[2]}` && method === "GET" && response.ok) {
        const row = await response.json();
        return Response.json({ ...row, patient_phone_numbers: [{ number: contactNumber, phone_type: "Mobile" }] });
      }
      if (url.pathname === "/v1/individual_appointments/91" && method === "GET") {
        state.targetReads++; await state.beforeTarget?.();
        const row = await response.json();
        lastTarget = { ...row, ...(cancelled ? { cancelled_at: verificationNow } : {}),
          links: { self: `${base}/individual_appointments/91` }, created_at: "2026-10-01T00:00:00.000Z",
          updated_at: state.targetVersion, did_not_arrive: null, patient_arrived: false };
        return Response.json(lastTarget);
      }
      return response;
    };
    const targetQueries: unknown[] = [];
    const target = { appointmentPolicyDigest: "e".repeat(64), authority: {
      allows: async (query: OutboundTargetQuery) => { targetQueries.push(query); await state.beforeTargetApproval?.(query); return state.targetAllowed; }, current: () => state.targetLive } };
    const observed = value(await value(ClinikoOutboundAppointmentTarget.create({ requests, appointmentPolicyDigest: target.appointmentPolicyDigest }, target.authority, native))
      .observeTarget({ patientId: verificationCanaries[2]!, appointmentRef: "cliniko:appointment:91" }, lifetime.signal));
    const request = { ...outboundRequestValue(), scope: f.scope, businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
      patientId: verificationCanaries[2]!, purpose: "sickDay" as const, recipient: { kind: "voice" as const, number: recipientNumber },
      appointment: { ref: observed.target.appointmentRef, digest: observed.digest }, requestedAt: verificationNow,
      schedule: { notBefore: verificationNow, expiresAt: "2026-10-09T06:00:00.000Z", timeZone: "Australia/Sydney", weekdays: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" } };
    notes = value(encodeOutboundRecipientRequest(request));
    const original = { recallRef: "cliniko:recall:40", attempt: { ...outboundLaunchValue(request).attempt,
      attemptedAt: verificationNow, dispatchNotAfter: "2026-10-04T06:01:00.000Z" } };
    const key = { accountRef: "outbound-clinical-account", providerCallRef: "outbound-clinical-" + randomUUID() }, callId = callIdFor(key), sessionId = randomUUID();
    const runtime = new CallRuntime(f.ledger, f.scope), clinicNumber = "+6125550199";
    value(await runtime.admit(callId, (await f.state()).policy, { direction: "outbound", key, clinicNumber, acceptedAt: verificationNow, deadline: "2026-10-04T06:00:30.000Z" }));
    value(await runtime.activate(callId, sessionId, verificationNow));
    const receipt = value(await f.ledger.findAdmission(callId))!;
    const context = value(await ClinikoOutboundClinicalContext.capture({ original, key, clinicNumber, requests, signal: lifetime.signal, fetchPort: native, target,
      records: { allows: async () => true, current: () => state.nativeLive }, authority: { allows: async () => true, current: () => state.live } }));
    const { inbound: _, representative: __, ...config } = f.config;
    const outgoingConfig = { ...config, cliniko: c, receipt, sessionId, outbound: context, fetchPort: native, signal: lifetime.signal };
    const owner = value(await ClinikoCancellationSession.createOutbound(outgoingConfig));
    const reception = new TextReception(f.ledger, f.policies, owner.effects, undefined, owner.appointments);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
    const currentState = async () => value(await f.ledger.read(callId, f.scope));
    const turn = (turnId: string, text = "Cancel my appointment"): FinalCallerTurn & Readonly<{ sessionId: string }> => ({ callId, sessionId, turnId, text, quality: "clear", at: verificationNow });
    const play = async () => {
      const id = (await currentState()).pendingPresentationId!; assert.ok(id);
      value(await runtime.startPresentation(callId, id, sessionId, verificationNow));
      value(await runtime.resolvePresentation(callId, id, "played", sessionId, verificationNow));
    };
    if ((await currentState()).pendingPresentationId) await play();
    const read = async (id = "targets") => {
      const proof = await owner.verified(); assert.ok(proof);
      return agent.submit({ kind: "appointments.read.v1", turn: turn(id), verificationRef: proof.verificationRef,
        from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow });
    };
    const select = async (choice: 1 | 2 | 3 = 1) => {
      const proof = await owner.verified(); assert.ok(proof);
      return reception.selectAppointment(f.scope, turn("choose"), proof.verificationRef, choice, verificationNow);
    };
    const propose = async () => {
      const proof = await owner.verified(); assert.ok(proof);
      return agent.submit({ kind: "appointments.change.propose.v1", turn: turn("proposal"),
        selection: { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" }, now: verificationNow });
    };
    return { ...f, owner, context, outgoingConfig, original, recipientNumber, nativeCalls, targetState: state, targetQueries, receipt, callId, sessionId, runtime, agent, reception,
      get patches() { return patches; }, get claims() { return f.claims; },
      get originalRequestNotes() { return notes; },
      setContactNumber: (number: string) => { contactNumber = number; },
      editOriginalRequest: () => { requestUpdatedAt = "2026-10-04T06:00:01.000Z"; },
      state: currentState, play, read, select, propose,
      verify: async () => {
        let wake: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        const sent = new Promise<void>((resolve, reject) => {
          wake = resolve;
          timer = setTimeout(() => reject(Error("Outgoing fixture did not deliver its registered-channel challenge")), 5000);
        });
        // begin's challenge work is joined by submitCode; wait only for the
        // owned synthetic delivery, never infer completion from elapsed time.
        const originalSend = outgoingConfig.delivery.send;
        outgoingConfig.delivery.send = async (...args) => { const result = await originalSend(...args); wake!(); return result; };
        try {
          owner.beginVerification();
          // The callback proves delivery; elapsed time only bounds failure.
          await sent;
          assert.equal((await owner.submitCode(f.mail.at(-1)!.code)).verified, true);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      },
      confirm: async () => { await play(); const action = Object.values((await currentState()).actions)[0]!;
        return reception.affirm(f.scope, turn("affirm", "Yes"), action.key, action.digest, verificationNow); },
      drain: () => reception.drain(f.scope, callId, verificationNow),
      close: async () => { lifetime.abort(); owner.dispose(); context.dispose(); await f.close(); } };
  } catch (error) { lifetime.abort(); await f.close(); throw error; }
}
