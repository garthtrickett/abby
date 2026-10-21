import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { MemoRetentionOutcome } from "../../src/standalone/administrative-memo-retention.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import { classMoveFixture } from "./class-move.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationCanaries } from "./caller-verification.ts";

export async function classMovementMemoFixture(options: { scope?: LocationScope; budget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget;
  barrierFor?: (scope: LocationScope, owner: string) => OutboundEffectBarrier; realQuotaWait?: boolean; passes?: boolean; staged?: boolean; admitted?: boolean;
  clinicalFetchAround?: (port: typeof fetch) => typeof fetch; memoFetchPort?: typeof fetch;
  mode?: "accepted" | "lostStored" | "lostUnstored" | "nonexact" } = {}) {
  const key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key), service = new AbortController();
  const memoPosts: Record<string, unknown>[] = [], memoRows: Record<string, unknown>[] = [], outcomes: MemoRetentionOutcome[] = [], consumed = new Set<string>();
  const gates = { allowed: true, producer: true, current: true, hold: undefined as Promise<void> | undefined, onAllowed: undefined as (() => Promise<void>) | undefined };
  let done!: () => void; const memoSettled = new Promise<void>(resolve => { done = resolve; });
  const f = await classMoveFixture(false, false, options.passes ? {} : undefined, options.staged ?? true, true, {
    ...(options.scope ? { scope: options.scope } : {}), ...(options.budget ? { budget: options.budget } : {}),
    ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}), ...(options.realQuotaWait ? { realQuotaWait: true } : {}),
    ...(options.clinicalFetchAround ? { fetchAround: options.clinicalFetchAround } : {}), memoFor: (clinical, clock) => {
    const native = { scope: clinical.scope, apiKey: clinical.apiKey, contactEmail: clinical.contactEmail, businessId: clinical.businessId,
      authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, rateBudget: clinical.rateBudget, clock, deadlineMs: 5000 };
    const owner = administrativeMemoRecordBinding(native, authentication)!;
    return { native, authentication, memoSignal: service.signal,
      authority: { allows: async () => { await gates.hold; await gates.onAllowed?.(); return gates.allowed; }, current: () => gates.current,
        producerAdmitted: async q => gates.producer && !!q.memo && q.memo.patientId === verificationCanaries[2] && q.memo.outcome.kind === "classMovementReported" },
      barrier: options.barrierFor?.(native.scope, owner) ?? { matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(native.scope) && binding === owner,
        claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } },
      observeOutcome: outcome => { outcomes.push(outcome); done(); }, fetchPort: options.memoFetchPort ?? (async (url, init) => {
        assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error");
        const body = JSON.parse(String(init.body)); memoPosts.push(body); const decoded = resultValue(decodeAdministrativeMemo(body.content));
        assert.equal(authentication.verify(decoded), true); assert.equal(body.patient_id, verificationCanaries[2]); assert.equal(body.confidential, true);
        const row = { ...body, id: "701", created_at: clock(), updated_at: clock(), archived_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } }, links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
        if (options.mode !== "lostUnstored") memoRows.push(row);
        if (options.mode === "lostStored" || options.mode === "lostUnstored") throw Error("Synthetic memo response loss");
        return Response.json(options.mode === "nonexact" ? { ...row, confidential: false } : row, { status: 201 });
      }) };
  } });
  const session = options.admitted ? resultValue(await ClinikoClassSession.create(f.classSessionConfig)) : undefined;
  const host = session?.rescheduling ?? f.host, reception = session ? new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, f.config.clock) : f.reception;
  const verify = async () => {
    if (!session) return f.verify();
    await f.play(); session.beginVerification(); const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.ok(f.mail[0]); assert.equal((await session.submitCode(f.mail[0].code)).verified, true); assert.equal(await f.session.verified(), undefined);
  };
  const initial = async () => {
    await verify(); const action = await f.prepare(reception); await f.play(); await f.pause(61);
    resultValue(await reception.affirm(f.scope, f.turn("memo-initial", "Yes"), action.key, action.digest, f.config.clock()));
    resultValue(await reception.drain(f.scope, f.callId, f.config.clock())); return action;
  };
  const next = async (actionKey: string) => {
    await f.play(); await f.pause(61); const previousMail = f.mail.length, signal = new AbortController().signal;
    let prepared = resultValue(await host.prepareClassMovement!({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
      policyVersion: f.config.policyVersion, now: f.config.clock(), signal, actionKey }));
    if (prepared.kind === "verificationRequired") {
      const until = Date.now() + 5000; while (f.mail.length <= previousMail && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail.length, previousMail + 1);
      assert.deepEqual(await host.submitClassMovementCode!(f.mail.at(-1)!.code, signal), { verified: true }); await f.pause(61);
      prepared = resultValue(await host.prepareClassMovement!({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
        policyVersion: f.config.policyVersion, now: f.config.clock(), signal, actionKey }));
    }
    assert.ok(prepared.kind === "ready"); resultValue(await f.runtime.prepareClassMovementConsent(f.callId, actionKey, prepared.evidence, f.config.clock(), prepared.expectedConversationRevision));
    const action = (await f.state()).actions[actionKey]!; await f.play();
    resultValue(await f.runtime.acceptTurn(f.turn("memo-next", "Yes"), { kind: "classMovementAffirm", actionKey, digest: action.classMovementConsent!.digest }, f.config.clock()));
    return reception.drain(f.scope, f.callId, f.config.clock());
  };
  return { ...f, host, reception, session, key, authentication, gates, memoPosts, memoRows, outcomes, consumed, memoSettled, initial, next, get claims() { return f.claims; },
    close: async () => { service.abort(); session?.dispose(); await f.close(); } };
}
