import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { AdministrativeMemoAuthentication, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ok } from "../../src/core/model.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { BookingMemoOutcome } from "../../src/standalone/cliniko-booking-memo.ts";
import { bookingSessionFixture } from "./booking-session.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Real admitted booking owner, file approvals, OTP/menu/SAM and native writer.
 * Provider replies and independent clinic memo grants remain synthetic. */
export async function bookingMemoSessionFixture(options: {
  clinicalFetchAround?: (port: typeof fetch) => typeof fetch; memoFetchPort?: typeof fetch;
  scope?: LocationScope; budget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget;
  barrierFor?: (scope: LocationScope, owner: string) => OutboundEffectBarrier;
  mode?: "accepted" | "lostStored" | "lostUnstored" | "nonexact";
} = {}) {
  const scope = options.scope ?? { tenantId: `memo-session-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const key = randomBytes(32), authentication = new AdministrativeMemoAuthentication(key), service = new AbortController();
  const rateBudget = options.budget ?? new ClinikoReadBudget(180), consumed = new Set<string>();
  const outcomes: BookingMemoOutcome[] = [], memoPosts: Record<string, unknown>[] = [], memoRows: Record<string, unknown>[] = [];
  let finish!: () => void; const memoSettled = new Promise<void>(resolve => { finish = resolve; });
  const gates = { allowed: true, producer: true, current: true };
  const native: AdministrativeMemoConfig = { scope, apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11",
    authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, rateBudget,
    clock: () => verificationNow, deadlineMs: 5000 };
  const owner = administrativeMemoRecordBinding(native, authentication)!;
  const barrier = options.barrierFor?.(scope, owner) ?? { matches: (s: LocationScope, binding: string) => JSON.stringify(s) === JSON.stringify(scope) && binding === owner,
    claimOnce: async (ref: string) => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } };
  const f = await bookingSessionFixture({ scope, budget: rateBudget, ...(options.clinicalFetchAround ? { fetchAround: options.clinicalFetchAround } : {}), ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}),
    memo: { native, authentication, memoSignal: service.signal, barrier,
      authority: { allows: async () => gates.allowed, current: () => gates.current,
        producerAdmitted: async q => gates.producer && q.memo?.patientId === verificationCanaries[2] },
      observeOutcome: outcome => { outcomes.push(outcome); finish(); },
      fetchPort: options.memoFetchPort ?? (async (url, init) => {
        assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error");
        const body = JSON.parse(String(init.body)); memoPosts.push(body);
        const decoded = decodeAdministrativeMemo(body.content); assert.ok(decoded.ok); assert.equal(authentication.verify(decoded.value), true);
        assert.equal(body.patient_id, verificationCanaries[2]); assert.equal(body.confidential, true);
        const row = { ...body, id: "701", created_at: verificationNow, updated_at: verificationNow, archived_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } }, links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
        if (options.mode !== "lostUnstored") memoRows.push(row);
        if (options.mode === "lostStored" || options.mode === "lostUnstored") throw Error("Synthetic memo acknowledgement lost");
        return Response.json(options.mode === "nonexact" ? { ...row, confidential: false } : row, { status: 201 });
      }) } });
  return { ...f, native, authentication, key, service, outcomes, memoPosts, memoRows, consumed, gates, memoSettled,
    prepare: async () => { const proof = await f.verify(); assert.ok((await f.readMenu()).ok); await f.playPending();
      assert.ok((await f.select()).ok); assert.ok((await f.confirm()).ok); return proof; },
    get posts() { return f.posts; },
    drainClinical: f.drain,
    drain: async () => { const result = await f.drain(); if (Object.values((await f.state()).actions).some(a => a.status === "committed")) await memoSettled; return result; },
    close: async () => { service.abort(); await f.close(); } };
}
