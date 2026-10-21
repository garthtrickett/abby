import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoQuery } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { ClinikoAdministrativeMemoConfig, MemoRetentionOutcome } from "../../src/standalone/administrative-memo-retention.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { cancellationSessionFixture } from "./cancellation-session.ts";
import { reschedulingSessionFixture } from "./rescheduling-session.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Actual admitted session, file approvals, email proof, protected menus, SAM,
 * native review and inspected mutation. Provider/mail/clinic grants synthetic. */
export async function appointmentChangeMemoFixture(kind: "cancel" | "reschedule", options: {
  clinicalFetchAround?: (port: typeof fetch) => typeof fetch; memoFetchPort?: typeof fetch;
  scope?: LocationScope; budget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget;
  barrierFor?: (scope: LocationScope, owner: string) => OutboundEffectBarrier;
  mode?: "accepted" | "lostStored" | "lostUnstored" | "nonexact" | "lateDisclosure";
  clinicalFault?: "responseLost" | "reviewLost" | "foreignInspection" | "conflict";
  practitionerOnly?: boolean; wrongMemoBudget?: boolean; deadlineMs?: number;
} = {}) {
  const scope = options.scope ?? { tenantId: `change-memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key), service = new AbortController();
  const budget = options.budget ?? new ClinikoReadBudget(180), outcomes: MemoRetentionOutcome[] = [], queries: AdministrativeMemoQuery[] = [];
  const memoPosts: Record<string, unknown>[] = [], memoRows: Record<string, unknown>[] = [], apiCalls: string[] = [], consumed = new Set<string>();
  let finish!: () => void; const memoSettled = new Promise<void>(resolve => { finish = resolve; });
  const gates = { allowed: true, producer: true, current: true, hold: undefined as Promise<void> | undefined,
    onAllowed: undefined as (() => Promise<void>) | undefined };
  const native = { scope, apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11", authorRef: "clinic-approved-admin-memo",
    policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, rateBudget: options.wrongMemoBudget ? new ClinikoReadBudget(180) : budget,
    clock: () => verificationNow, deadlineMs: options.deadlineMs ?? 5000 };
  const owner = administrativeMemoRecordBinding(native, authentication)!;
  const barrier = options.barrierFor?.(scope, owner) ?? { matches: (s: LocationScope, binding: string) => JSON.stringify(s) === JSON.stringify(scope) && binding === owner,
    claimOnce: async (ref: string) => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } };
  const memo: ClinikoAdministrativeMemoConfig = { native, authentication, barrier, memoSignal: service.signal,
    authority: { allows: async q => { queries.push(q); await gates.hold; await gates.onAllowed?.(); return gates.allowed; }, current: () => gates.current,
      producerAdmitted: async q => gates.producer && !!q.memo && q.memo.patientId === verificationCanaries[2] &&
        q.memo.outcome.kind === (kind === "cancel" ? "cancellationObserved" : "reschedulingObserved") },
    observeOutcome: outcome => { outcomes.push(outcome); finish(); },
    fetchPort: options.memoFetchPort ?? (async (url, init) => {
      assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error");
      const body = JSON.parse(String(init.body)); memoPosts.push(body); const decoded = decodeAdministrativeMemo(body.content); assert.ok(decoded.ok);
      assert.equal(authentication.verify(decoded.value), true); assert.equal(body.patient_id, verificationCanaries[2]);
      const row = { ...body, id: "701", created_at: verificationNow, updated_at: verificationNow, archived_at: null,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } }, links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
      if (options.mode !== "lostUnstored") memoRows.push(row);
      if (options.mode === "lostStored" || options.mode === "lostUnstored") throw Error("Synthetic memo acknowledgement lost");
      if (options.mode === "nonexact") return Response.json({ ...row, confidential: false }, { status: 201 });
      if (options.mode === "lateDisclosure") return new Response(new ReadableStream({ pull(controller) {
        gates.current = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(row))); controller.close();
      } }, { highWaterMark: 0 }), { status: 201 });
      return Response.json(row, { status: 201 });
    }) };
  let sent = false;
  const around = (base: typeof fetch): typeof fetch => {
    const clinical: typeof fetch = async (url, init) => {
      const u = new URL(String(url)), method = init?.method ?? "GET"; apiCalls.push(`${method} ${u.pathname}`);
      const response = await base(url, init); if (method === "PATCH") sent = true;
      if (sent && method === "GET" && u.pathname === "/v1/individual_appointments/91" && options.clinicalFault === "foreignInspection") {
        const row = await response.json(); return Response.json({ ...row, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/43" } } });
      }
      if (sent && u.pathname.endsWith("/conflicts") && options.clinicalFault === "conflict") return Response.json({ conflicts: { exist: true } });
      return response;
    };
    return options.clinicalFetchAround?.(clinical) ?? clinical;
  };
  const f = kind === "cancel" ? await cancellationSessionFixture({ scope, rateBudget: budget, memo, fetchAround: around,
    ...(options.verificationBudget ? { budget: options.verificationBudget } : {}),
    ...(options.clinicalFault === "responseLost" ? { lostWrite: true } : {}), ...(options.clinicalFault === "reviewLost" ? { lostRecall: true } : {}) }) :
    await reschedulingSessionFixture({ scope, rateBudget: budget, memo, fetchAround: around,
      ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}),
      ...(options.clinicalFault === "responseLost" ? { lostMove: true } : {}), ...(options.clinicalFault === "reviewLost" ? { lostRecall: true } : {}),
      ...(options.practitionerOnly ? { destinationPractitionerId: "23", sameTime: true,
        practitionerMoves: [{ fromPractitionerId: "22", toPractitionerId: "23", appointmentTypeId: "33", durationMinutes: 30 }] } : {}) });
  const drainClinical = async () => { await f.drain(); return f.state(); };
  return { scope, native, key, authentication, folder: f.folder, service, budget, outcomes, queries, memoPosts, memoRows, consumed, gates, memoSettled, apiCalls,
    mail: f.mail, recalls: f.recalls, state: f.state, callId: f.callId, sessionId: f.sessionId, owner: f.owner, drainClinical,
    get patches() { return f.patches; },
    prepare: async () => {
      if ((await f.state()).pendingPresentationId) await f.playPending();
      f.owner.beginVerification(); const deadline = Date.now() + 5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(f.mail[0]); assert.equal((await f.owner.submitCode(f.mail[0].code)).verified, true);
      const verified = await f.owner.verified(); assert.ok(verified);
      if ("proposalJourney" in f) await f.proposalJourney();
      else { assert.ok((await f.read(verified.verificationRef)).ok); await f.playPending(); assert.ok((await f.propose(verified.verificationRef)).ok); }
      const confirmed = await f.confirm(); if (confirmed) assert.ok(confirmed.ok); return verified.verificationRef;
    },
    drain: async () => { const state = await drainClinical(); if (Object.values(state.actions).some(a => a.status === "committed")) await memoSettled; return state; },
    close: async () => { service.abort(); await f.close(); } };
}
