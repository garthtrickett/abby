import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { MemoRetentionOutcome } from "../../src/standalone/administrative-memo-retention.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { classCancellationFixture } from "./class-cancellation.ts";
import { verificationCanaries } from "./caller-verification.ts";

/** Real admitted class cancellation. Transport, mail and clinic grants synthetic;
 * callers must not confuse the old200 pass source profile with real180 proof. */
export async function classCancellationMemoFixture(options: { passes?: "releaseOne" | "unchanged" | "consumeOne"; budgetLimit?: 180 | 200; realQuotaWait?: boolean;
  scope?: LocationScope; budget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget;
  barrierFor?: (scope: LocationScope, owner: string) => OutboundEffectBarrier;
  mode?: "accepted" | "lostStored" | "lostUnstored" | "nonexact"; foreignInspection?: boolean } = {}) {
  const key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key), service = new AbortController();
  const memoPosts: Record<string, unknown>[] = [], memoRows: Record<string, unknown>[] = [], outcomes: MemoRetentionOutcome[] = [], consumed = new Set<string>();
  const gates = { allowed: true, producer: true, current: true, hold: undefined as Promise<void> | undefined,
    onAllowed: undefined as (() => Promise<void>) | undefined };
  let done!: () => void; const memoSettled = new Promise<void>(resolve => { done = resolve; });
  let patched = false;
  const f = await classCancellationFixture({ ...(options.passes ? { passes: options.passes } : {}), budgetLimit: options.budgetLimit ?? 180,
    ...(options.scope ? { scope: options.scope } : {}), ...(options.budget ? { budget: options.budget } : {}),
    ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}),
    fetchAround: port => async (url, init) => {
      const response = await port(url, init); if (init?.method === "PATCH") patched = true;
      if (patched && options.foreignInspection && (init?.method ?? "GET") === "GET" && new URL(String(url)).pathname === "/v1/attendees/101") {
        return Response.json({ ...await response.json(), patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/43" } } });
      }
      return response;
    }, memoFor: (clinical, clock) => {
      const native = { scope: clinical.scope, apiKey: clinical.apiKey, contactEmail: clinical.contactEmail, businessId: clinical.businessId,
        authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, rateBudget: clinical.rateBudget, clock, deadlineMs: 5000 };
      const owner = administrativeMemoRecordBinding(native, authentication)!;
      return { native, authentication, memoSignal: service.signal,
        authority: { allows: async () => { await gates.hold; await gates.onAllowed?.(); return gates.allowed; }, current: () => gates.current,
          producerAdmitted: async query => gates.producer && !!query.memo && query.memo.patientId === verificationCanaries[2] && query.memo.outcome.kind === "classCancellationObserved" },
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
  let session: ClinikoClassSession;
  try { session = resultValue(await ClinikoClassSession.create(f.classSessionConfig)); } catch (error) { service.abort(); await f.close(); throw error; }
  const reception = new TextReception(f.ledger, f.policies, session.effects, undefined, session.appointments, undefined, undefined, f.classSessionConfig.clock);
  const gateway = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
  const drainClinical = () => reception.drain(f.scope, f.callId, f.classSessionConfig.clock());
  return { ...f, session, key, authentication, service, gates, memoPosts, memoRows, outcomes, consumed, memoSettled, get claims() { return f.claims; },
    prepare: async () => {
      await f.play(); session.beginVerification(); const deadline = Date.now() + 5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(f.mail[0]); assert.equal((await session.submitCode(f.mail[0].code)).verified, true); const grant = await session.verified(); assert.ok(grant);
      resultValue(await gateway.submit({ kind: "appointments.read.v1", turn: f.turn("memo-read"), verificationRef: grant.verificationRef,
        from: f.classSessionConfig.clock(), to: "2026-10-09T10:00:00.000Z", now: f.classSessionConfig.clock() }));
      await f.play(); resultValue(await gateway.submit({ kind: "appointments.change.propose.v1", turn: f.turn("memo-cancel"),
        selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: f.classSessionConfig.clock() }));
      const action = Object.values((await f.state()).actions).at(-1)!; await f.play();
      const confirm = () => reception.affirm(f.scope, f.turn("memo-confirm", "Yes"), action.key, action.digest, f.classSessionConfig.clock());
      const confirmed = resultValue(await confirm()), notice = confirmed.pendingPresentationId ? confirmed.presentations[confirmed.pendingPresentationId] : undefined;
      if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
        await f.play(); let seconds = notice.confirmationWaitSeconds + 1;
        if (options.realQuotaWait) while (seconds > 0) { const step = Math.min(15, seconds); await new Promise<void>(resolve => setTimeout(resolve, step * 1000)); await f.pause(step); seconds -= step; }
        else await f.pause(seconds);
        resultValue(await confirm());
      }
      return action;
    }, drainClinical,
    drain: async () => { const result = await drainClinical(); if (Object.values((await f.state()).actions).some(a => a.status === "committed")) await memoSettled; return result; },
    close: async () => { service.abort(); session.dispose(); await f.close(); } };
}
