import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { MemoRetentionOutcome } from "../../src/standalone/administrative-memo-retention.ts";
import { ok } from "../../src/core/model.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { financialClassBookingFixture } from "./financial-class-booking.ts";
import { verificationCanaries } from "./caller-verification.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";

/** Real class SAM/approval/native writer. Clinic grants, mail and transport are synthetic. */
export async function classBookingMemoFixture(options: { passes?: boolean; admitted?: boolean; realQuotaWait?: boolean; mode?: "accepted" | "lostStored" | "lostUnstored" | "nonexact";
  scope?: LocationScope; budget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget;
  barrierFor?: (scope: LocationScope, owner: string) => OutboundEffectBarrier } = {}) {
  const key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key), service = new AbortController();
  const memoPosts: Record<string, unknown>[] = [], memoRows: Record<string, unknown>[] = [], outcomes: MemoRetentionOutcome[] = [], consumed = new Set<string>();
  const gates = { allowed: true, producer: true, current: true, hold: undefined as Promise<void> | undefined };
  let done!: () => void; const memoSettled = new Promise<void>(resolve => { done = resolve; });
  const f = await financialClassBookingFixture({ passes: options.passes ?? false, required: false, budgetLimit: 180,
    ...(options.scope ? { scope: options.scope } : {}), ...(options.budget ? { budget: options.budget } : {}),
    ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}), memoFor: (clinical, clock) => {
    const native = { scope: clinical.scope, apiKey: clinical.apiKey, contactEmail: clinical.contactEmail, businessId: clinical.businessId,
      authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, rateBudget: clinical.rateBudget, clock, deadlineMs: 5000 };
    const owner = administrativeMemoRecordBinding(native, authentication)!;
    return { native, authentication, memoSignal: service.signal,
      authority: { allows: async () => { await gates.hold; return gates.allowed; }, current: () => gates.current,
        producerAdmitted: async query => gates.producer && !!query.memo && query.memo.patientId === verificationCanaries[2] && query.memo.outcome.kind === "classBookingConfirmed" },
      barrier: options.barrierFor?.(native.scope, owner) ?? { matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(native.scope) && binding === owner,
        claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } },
      observeOutcome: result => { outcomes.push(result); done(); },
      fetchPort: async (url, init) => {
        assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error");
        const body = JSON.parse(String(init.body)); memoPosts.push(body); assert.equal(body.patient_id, verificationCanaries[2]); assert.equal(body.confidential, true);
        const decoded = decodeAdministrativeMemo(body.content); assert.ok(decoded.ok && authentication.verify(decoded.value));
        const row = { ...body, id: "701", created_at: clock(), updated_at: clock(), archived_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } }, links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
        if (options.mode !== "lostUnstored") memoRows.push(row);
        if (options.mode === "lostStored" || options.mode === "lostUnstored") throw Error("Synthetic memo response loss");
        return Response.json(options.mode === "nonexact" ? { ...row, confidential: false } : row, { status: 201 });
      } };
  } });
  let admitted: ClinikoClassSession | undefined, reception = f.reception;
  if (options.admitted) {
    try {
      admitted = resultValue(await ClinikoClassSession.create(f.classSessionConfig));
      reception = new TextReception(f.ledger, f.policies, admitted.effects, undefined, admitted.appointments, undefined, undefined, f.classSessionConfig.clock);
    } catch (error) { service.abort(); await f.close(); throw error; }
  }
  const host = admitted?.booking ?? f.host;
  const waitForQuota = async (seconds: number) => {
    if (!options.realQuotaWait) return f.pause(seconds);
    // SQL owns its real clock. Renew the synthetic connected-call lease in
    // bounded steps while actually waiting; never age SQL rows or waive quota.
    while (seconds > 0) { const step = Math.min(15, seconds); await new Promise<void>(resolve => setTimeout(resolve, step * 1000)); await f.pause(step); seconds -= step; }
  };
  const drainClinical = () => reception.drain(f.scope, f.callId, f.classSessionConfig.clock());
  return { ...f, host, admitted, key, authentication, service, gates, memoPosts, memoRows, outcomes, consumed, memoSettled, get claims() { return f.claims; },
    prepare: async () => {
      if (admitted) {
        await f.play(); admitted.beginVerification(); const deadline = Date.now() + 5000;
        while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
        assert.ok(f.mail[0]); assert.equal((await admitted.submitCode(f.mail[0].code)).verified, true); assert.equal(await f.session.verified(), undefined);
        resultValue(await reception.readBookingMenu(f.scope, f.turn("memo-menu"), "2026-10-08", "2026-10-08", f.classSessionConfig.clock()));
        await f.play(); resultValue(await reception.selectBookingMenu(f.scope, f.turn("memo-choice"), 1, f.classSessionConfig.clock()));
        const action = Object.values((await f.state()).actions).at(-1)!; await f.play();
        const confirm = () => reception.affirm(f.scope, f.turn("memo-confirm", "Yes"), action.key, action.digest, f.classSessionConfig.clock());
        const confirmed = resultValue(await confirm()), notice = confirmed.pendingPresentationId ? confirmed.presentations[confirmed.pendingPresentationId] : undefined;
        if (notice?.kind === "notice" && notice.confirmationWaitSeconds) { await f.play(); await waitForQuota(notice.confirmationWaitSeconds + 1); resultValue(await confirm()); }
        return action;
      }
      await f.verify(); const action = await f.propose(); const confirmed = resultValue(await f.confirm());
      const notice = confirmed.pendingPresentationId ? confirmed.presentations[confirmed.pendingPresentationId] : undefined;
      if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
        await f.play(); await f.pause(notice.confirmationWaitSeconds + 1); resultValue(await f.confirm());
      }
      return action;
    },
    drainClinical,
    drain: async () => { const result = await drainClinical(); if (Object.values((await f.state()).actions).some(action => action.status === "committed")) await memoSettled; return result; },
    close: async () => { service.abort(); admitted?.dispose(); await f.close(); } };
}
