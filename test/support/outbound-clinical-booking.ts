import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CallRuntime } from "../../src/core/runtime.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { ClinikoOutboundClinicalContext } from "../../src/standalone/cliniko-outbound-clinical-context.ts";
import { ClinikoBookingSession } from "../../src/standalone/cliniko-booking-session.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { bookingSessionFixture } from "./booking-session.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { value } from "./outbound-records.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Conditional actual booking owner; remote source/grants/mail/native HTTP are
 * synthetic. This fixture is not a signed voice or financial acceptance claim. */
export async function outboundClinicalBookingFixture() {
  const f = await bookingSessionFixture(); f.owner.dispose();
  const lifetime = new AbortController(), c = f.config.cliniko, base = "https://api.au5.cliniko.com/v1";
  let notes = "", requestVersion = verificationNow, posts = 0, stored: Record<string, unknown> | undefined;
  let contactNumber = "+61481937526";
  const grants = { original: true, native: true }, nativeCalls: { path: string; method: string }[] = [];
  const key = { accountRef: "outbound-booking-account", providerCallRef: "outbound-booking-" + randomUUID() }, callId = callIdFor(key), sessionId = randomUUID();
  const state = async () => value(await f.ledger.read(callId, f.scope));
  const native: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; nativeCalls.push({ path: url.pathname, method });
    if (url.pathname === "/v1/recalls/30" && method === "GET") return Response.json({ id: "30", links: { self: `${base}/recalls/30` },
      patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: `${base}/recall_types/61` } },
      notes, recall_at: "2026-10-05", recalled: false, recalled_at: null, archived_at: null, created_at: verificationNow, updated_at: requestVersion });
    if (url.pathname === "/v1/individual_appointments" && method === "POST") {
      const current = await state(), action = Object.values(current.actions)[0]!;
      assert.equal(action.status, "dispatched"); assert.equal(current.presentations[action.presentationId]?.status, "played");
      assert.equal(f.recalls.length, 1); assert.equal(posts, 0);
      const body = JSON.parse(String(init?.body)); assert.deepEqual([body.business_id, body.practitioner_id, body.appointment_type_id], ["11", "22", "33"]);
      const review = value(decodeClinikoReview(f.recalls[0]!.notes)); assert.equal(review.request.operation.kind, "book");
      if (review.request.operation.kind !== "book") throw Error("Expected booking review");
      assert.equal(body.patient_id, original.attempt.patientId); assert.equal(body.starts_at, review.request.operation.startsAt);
      assert.equal(body.ends_at, review.request.operation.endsAt);
      posts++; stored = { id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: body.ends_at, cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } }, business: { links: { self: `${base}/businesses/11` } },
        practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      return Response.json(stored, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments/91" && method === "GET" && stored) return Response.json(stored);
    const response = await f.ownerPorts.fetchPort(input, init);
    if (url.pathname.startsWith("/v1/patients/") && response.ok)
      return Response.json({ ...await response.json(), patient_phone_numbers: [{ number: contactNumber, phone_type: "Mobile" }] });
    return response;
  };
  const requests = { scope: f.scope, apiKey: c.apiKey, contactEmail: c.contactEmail, businessId: c.businessId, outboundRecallTypeId: "61",
    recordPolicyDigest: "d".repeat(64), rateBudget: c.rateBudget, clock: () => verificationNow };
  const request = { ...outboundRequestValue(), scope: f.scope, businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    patientId: verificationCanaries[2]!, purpose: "followUp" as const, recipient: { kind: "voice" as const, number: contactNumber }, requestedAt: verificationNow,
    schedule: { notBefore: verificationNow, expiresAt: "2026-10-09T06:00:00.000Z", timeZone: "Australia/Sydney", weekdays: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" } };
  notes = value(encodeOutboundRecipientRequest(request));
  const original = { recallRef: "cliniko:recall:40", attempt: { ...outboundLaunchValue(request).attempt,
    attemptedAt: verificationNow, dispatchNotAfter: "2026-10-04T06:01:00.000Z" } };
  const runtime = new CallRuntime(f.ledger, f.scope), clinicNumber = "+6125550199";
  value(await runtime.admit(callId, (await f.state()).policy, { direction: "outbound", key, clinicNumber, acceptedAt: verificationNow, deadline: "2026-10-04T06:00:30.000Z" }));
  value(await runtime.activate(callId, sessionId, verificationNow));
  const receipt = value(await f.ledger.findAdmission(callId))!;
  const context = value(await ClinikoOutboundClinicalContext.capture({ requests, original, key, clinicNumber, signal: lifetime.signal, fetchPort: native,
    records: { allows: async () => true, current: () => grants.native }, authority: { allows: async () => true, current: () => grants.original } }));
  const { inbound: _, representative: __, ...baseConfig } = f.config;
  const config = { ...baseConfig, receipt, sessionId, outbound: context, signal: lifetime.signal, fetchPort: native };
  const owner = value(await ClinikoBookingSession.createOutbound(config));
  const reception = new TextReception(f.ledger, f.policies, owner.effects);
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
  const turn = (turnId: string, text = "Book my follow-up") => ({ callId, sessionId, turnId, text, quality: "clear" as const, at: verificationNow });
  const play = async () => { const id = (await state()).pendingPresentationId!; assert.ok(id);
    value(await runtime.startPresentation(callId, id, sessionId, verificationNow)); value(await runtime.resolvePresentation(callId, id, "played", sessionId, verificationNow)); };
  if ((await state()).pendingPresentationId) await play();
  return { ...f, owner, config, context, original, nativeCalls, callId, sessionId, receipt, state, grants, runtime, reception, agent, play, turn,
    get posts() { return posts; }, get claims() { return f.claims; },
    editOriginal: () => { requestVersion = "2026-10-04T06:00:01.000Z"; }, changeContact: () => { contactNumber = "+61481937527"; },
    verify: async () => { owner.beginVerification(); const end = Date.now() + 5000;
      while (!f.mail.length && Date.now() < end) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(f.mail[0]); assert.equal((await owner.submitCode(f.mail[0].code)).verified, true); },
    read: () => agent.submit({ kind: "booking.offers.read.v1", turn: turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow }),
    select: () => agent.submit({ kind: "booking.offers.select.v1", turn: turn("select"), choice: 1, now: verificationNow }),
    confirm: async () => { await play(); const action = Object.values((await state()).actions)[0]!;
      return reception.affirm(f.scope, turn("yes", "Yes"), action.key, action.digest, verificationNow); },
    drain: () => reception.drain(f.scope, callId, verificationNow),
    close: async () => { lifetime.abort(); context.dispose(); owner.dispose(); await f.close(); } };
}
