import assert from "node:assert/strict";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ok } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { ClinikoBookingHost } from "../../src/standalone/cliniko-booking-host.ts";
import type { ClinikoBookingOffersConfig } from "../../src/standalone/cliniko-booking-offers.ts";
import type { ClinikoBookingAuthority, ClinikoBookingEvidence } from "../../src/standalone/cliniko-booking-authority.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { callerVerificationFixture, verificationCanaries, verificationNow } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function standaloneBookingFixture(options: { scope?: LocationScope; verificationBudget?: PatientVerificationBudget; rateBudget?: ClinikoRequestBudget;
  fetchPort?: typeof fetch; fetchAround?: (port: typeof fetch) => typeof fetch;
  authorityFor?: (config: Omit<ClinikoBookingOffersConfig, "policy">, port: typeof fetch) => Promise<ClinikoBookingAuthority>; operation?: PatientOperation; staffWorkEnabled?: boolean; lostRecall?: boolean; lostBooking?: boolean; appointmentChanges?: true } = {}) {
  const f = await callerVerificationFixture({ operation: options.operation ?? "appointments.book", bookingExecute: true,
    ...(options.appointmentChanges ? { cancellationExecute: true, reschedulingExecute: true } : {}),
    ...(options.staffWorkEnabled === undefined ? {} : { staffWorkEnabled: options.staffWorkEnabled }), ...(options.scope ? { scope: options.scope } : {}) });
  f.session.dispose();
  const apiKey = "synthetic-session-au5", base = "https://api.au5.cliniko.com/v1";
  const traffic: string[] = [], mail: { email: string; code: string }[] = [], recalls: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> | undefined, posts = 0, claims = 0, conflict = "clear", inspected = "exact", authorityPermitted = true;
  let onRecall: () => Promise<void> = async () => undefined, onBooking: () => Promise<void> = async () => undefined;
  let onConflict: () => Promise<void> = async () => undefined;
  let evidence: ClinikoBookingEvidence = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    patientId: verificationCanaries[2]!, businessId: "11", practitionerId: "22", appointmentTypeId: "33", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
    offer: { scope: f.scope, offerRef: "selected-offer", serviceRef: "physiotherapy", startsAt: "2026-10-08T04:00:00.000Z", expiresAt: "2026-10-04T06:04:00.000Z" },
    endsAt: "2026-10-08T04:30:00.000Z", timeZone: "Australia/Sydney", bookingPolicyVersion: "book-policy-1", contract: "bestEffort" };
  const sourceQueries: string[] = [];
  let host: ClinikoBookingHost | undefined, session: CallerVerificationSession | undefined;
  const rateBudget = options.rateBudget ?? { claim: async () => { claims++; return null; }, observe429: async () => ({ kind: "rateLimited" as const }) };
  const baseFetch: typeof fetch = options.fetchPort ?? (async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    if (url.pathname.startsWith("/v1/patients/")) return Response.json({ id: verificationCanaries[2], email: verificationCanaries[0], archived_at: null,
      patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }], notes: verificationCanaries[1] });
    if (url.pathname === "/v1/recalls") {
      if (method === "GET") return Response.json({ total_entries: recalls.length, recalls });
      assert.equal(method, "POST"); const body = JSON.parse(String(init?.body));
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      recalls.push(row); await onRecall();
      if (options.lostRecall) throw new Error("synthetic lost review response");
      return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments" && method === "POST") {
      posts++; assert.equal(recalls.length, 1);
      const action = Object.values((await f.state()).actions)[0]!;
      assert.equal(action.status, "dispatched"); assert.equal((await f.state()).presentations[action.presentationId]?.status, "played");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual([body.business_id, body.practitioner_id, body.appointment_type_id], ["11", "22", "33"]);
      const review = decodeClinikoReview(recalls[0]!.notes); assert.ok(review.ok);
      assert.ok(review.value.request.operation.kind === "book");
      assert.equal(body.ends_at, review.value.request.operation.endsAt, "the write must bind the confirmed review's complete interval");
      stored = { id: "91", notes: body.notes, starts_at: body.starts_at, ends_at: body.ends_at, cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } }, business: { links: { self: `${base}/businesses/11` } },
        practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } };
      await onBooking(); if (options.lostBooking) throw new Error("synthetic lost booking response");
      return Response.json(stored, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments/91") {
      if (inspected === "unavailable") return new Response(null, { status: 503 });
      if (inspected === "malformed") return Response.json({ id: "91" });
      const row = { ...stored };
      if (inspected === "duration") row.ends_at = "2026-10-08T05:30:00.000Z";
      if (inspected === "patient") row.patient = { links: { self: `${base}/patients/43` } };
      if (inspected === "cancelled") row.cancelled_at = verificationNow;
      if (inspected === "marker") row.notes = "foreign marker";
      return Response.json(row);
    }
    assert.equal(url.pathname, "/v1/individual_appointments/91/conflicts");
    await onConflict();
    if (conflict === "unavailable") return new Response(null, { status: 503 });
    return Response.json({ conflicts: { exist: conflict === "malformed" ? "false" : conflict === "present" } });
  });
  const fetchPort = options.fetchAround ? options.fetchAround(baseFetch) : baseFetch;
  try {
    session = resultValue(CallerVerificationSession.create({ ...f.sessionConfig,
      contact: new ClinikoVerificationContactReader({ scope: f.scope, apiKey, contactEmail: "test@example.test", countryCallingCode: "61", rateBudget }, fetchPort),
      budget: options.verificationBudget ?? { reserve: async () => true }, delivery: { send: async (email, code) => { mail.push({ email, code }); return true; } } }));
    const writerConfig = { scope: f.scope, apiKey, contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", rateBudget };
    const writer = resultValue(ClinikoBookingWriter.create(writerConfig, fetchPort, f.sessionConfig.clock));
    const resolve: ClinikoBookingAuthority["resolve"] = async query => {
      sourceQueries.push(query.phase); return authorityPermitted ? ok(structuredClone(evidence)) : { ok: false, error: { kind: "unavailable", target: "offer" } };
    };
    const authority: ClinikoBookingAuthority = options.authorityFor ? await options.authorityFor({ ...writerConfig, proof: session.proof,
      callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion, clock: f.sessionConfig.clock }, fetchPort) : { resolve, resolveForSend: resolve };
    host = new ClinikoBookingHost({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
      ledger: f.ledger, policy: f.policies, proof: session.proof, authority, writer,
      recallWriter: resultValue(ClinikoRecallWriter.create(writerConfig, fetchPort)), recallTypeId: "7", timeZone: "Australia/Sydney", clock: f.sessionConfig.clock });
    const reception = new TextReception(f.ledger, f.policies, host);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
    const turn = (turnId: string, text = "Book physiotherapy") => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, quality: "clear" as const, at: verificationNow });
    async function verify() {
      session!.begin(); const deadline = Date.now() + 5000;
      while (!mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(mail[0]); assert.equal((await session!.submitCode(mail[0].code)).verified, true);
      const grant = await session!.verified(); assert.ok(grant); return grant.verificationRef;
    }
    async function confirm(played = true) {
      const action = Object.values((await f.state()).actions)[0];
      assert.ok(action, "proposal must create an actual SAM action before confirmation");
      if (played) {
        resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, verificationNow));
        resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, verificationNow));
      }
      return reception.affirm(f.scope, turn("affirm", "Yes"), action.key, action.digest, verificationNow);
    }
    return { ...f, session, host, writer, authority, evidence, traffic, mail, recalls, sourceQueries, verify, confirm, reception, agent, turn,
      propose: (verificationRef: string, turnId = "proposal", offerRef = "selected-offer") => agent.submit({ kind: "booking.propose.v2", turn: turn(turnId), verificationRef, offerRef, now: verificationNow }),
      drain: () => reception.drain(f.scope, f.callId, verificationNow),
      discovery: async () => resultValue(await resultValue(ClinikoRecallReader.create(writerConfig, fetchPort)).discoverPendingReviews(f.scope, "7")),
      setEvidence: (patch: Partial<ClinikoBookingEvidence>) => { evidence = { ...evidence, ...patch }; },
      setPermitted: f.setPermitted, denyAuthority: () => { authorityPermitted = false; },
      setInspection: (value: string) => { inspected = value; }, setConflict: (value: string) => { conflict = value; },
      setOnRecall: (run: () => Promise<void>) => { onRecall = run; }, setOnBooking: (run: () => Promise<void>) => { onBooking = run; },
      setOnConflict: (run: () => Promise<void>) => { onConflict = run; },
      get posts() { return posts; }, get claims() { return claims; },
      close: async () => { host?.dispose(); session?.dispose(); await f.close(); } };
  } catch (error) { host?.dispose(); session?.dispose(); await f.close(); throw error; }
}
