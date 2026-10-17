import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { classBookingFixture } from "./class-booking.ts";
import { fixture, intentValue, keys, keyRef, value } from "./financial-retention.ts";
import { verificationNow } from "./caller-verification.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import type { FinancialBookingAssessment, FinancialBookingPreparationConfig, FinancialBookingSelection } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";

export async function financialClassBookingFixture(options: { passes?: boolean; required?: boolean; budgetLimit?: 180 | 200; scope?: import("../../src/core/model.ts").LocationScope;
  quote?: (selection: FinancialBookingSelection, ordinary: FinancialBookingAssessment) => FinancialBookingAssessment | undefined;
  barrierFor?: (native: FinancialBookingPreparationConfig["native"]) => FinancialBookingPreparationConfig["barrier"];
  lostIntent?: boolean; lostObservation?: boolean; onObservation?: () => void; play?: FinancialBookingPreparationConfig["presentation"]["play"] } = {}) {
  let funding!: ReturnType<typeof fixture>, config!: FinancialBookingPreparationConfig, allowed = true;
  let clock = () => verificationNow;
  const financialLife = new AbortController(), events: string[] = [], texts: string[] = [], selections: FinancialBookingSelection[] = [];
  const f = await classBookingFixture({ ...(options.passes ? { passes: true } : {}), ...(options.scope ? { scope: options.scope } : {}), ...(options.budgetLimit ? { budgetLimit: options.budgetLimit } : {}),
    fetchAround: port => async (input, init) => {
      const url = new URL(String(input)), body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === "/v1/recalls" && init?.method === "GET" && url.searchParams.getAll("q[]").some(q => q.startsWith("patient_id:="))) {
        const all: Record<string, unknown>[] = [...funding.rows.values(), ...f.recalls.map(r => ({ ...r,
          links: { self: `${url.origin}/v1/recalls/${r.id}` }, created_at: verificationNow, updated_at: verificationNow }))];
        all.sort((a, b) => Number(a.id) - Number(b.id)); const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json({ total_entries: all.length, recalls: all.slice((page - 1) * 100, page * 100) });
      }
      if (url.pathname === "/v1/recalls" && body?.recall_type_id === "40" || url.pathname.startsWith("/v1/recalls/") && funding?.rows.has(url.pathname.split("/").at(-1)!)) {
        events.push(`financial:${init?.method ?? "GET"}`); return funding.port(input, init);
      }
      events.push(`clinical:${init?.method ?? "GET"}:${url.pathname}`); return port(input, init);
    }, financialFor: (native, fetchPort) => {
      funding = fixture({ intent: { ...intentValue(), scope: native.scope }, config: { scope: native.scope, apiKey: native.apiKey,
        businessId: native.businessId, contactEmail: native.contactEmail, rateBudget: native.rateBudget, clock: () => clock() },
        barrierFactory: native => {
          if (options.barrierFor) return options.barrierFor(native);
          const burned = new Set<string>(), owner = value(financialRecordOwnerBinding(native));
          return { matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(native.scope) && binding === owner,
            claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } };
        }, response: (row, method) => {
          if (method === "POST") {
            row.created_at = clock(); row.updated_at = clock();
            if (options.lostIntent && String(row.notes).includes("financial intent")) throw new Error("Synthetic lost class financial intent response");
            if (String(row.notes).includes("financial booking observation")) {
              options.onObservation?.(); if (options.lostObservation) throw new Error("Synthetic lost class financial observation response");
            }
          }
          return Response.json(row, { status: method === "POST" ? 201 : 200 });
        } });
      config = { native: funding.config, privateKey: keys.privateKey, sourceAuthorized: async () => allowed,
        authority: funding.authority, barrier: funding.barrier, financialSignal: financialLife.signal, fetchPort,
        policy: { quote: async selection => {
          selections.push(structuredClone(selection));
          const q: FinancialBookingAssessment = options.required === false ? { kind: "notRequired", version: "class-no-deposit-1", expiresAt: selection.expiresAt } : {
            kind: "required", payment: { amount: 1200, currency: "gbp", policyVersion: "class-fees-1", termsVersion: "class-financial-terms-1", deadline: "2026-10-05T04:00:00.000Z" },
            recipient: { kind: "email", address: "class-financial-recipient@example.invalid" }, approvedTerms: "The clinic will review late payment. A pass count does not prove payment.",
            reviewDate: "2026-10-05", expiresAt: selection.expiresAt };
          return options.quote ? options.quote(selection, q) : q;
        }, current: async () => allowed, currentForSend: () => allowed },
        presentation: { play: async (text, signal, canPresent) => { texts.push(text); return options.play ? options.play(text, signal, canPresent) :
          canPresent() ? { presentationRef: randomUUID(), playedAt: clock() } : undefined; } } };
      return config;
    } });
  clock = f.classSessionConfig.clock;
  const c = f.classSessionConfig;
  const flowConfig: ClinikoCallFlowConfig = { ...c,
    approvals: { bookCaller: c.callerApprovalPath, cancelCaller: c.callerApprovalPath, rescheduleCaller: c.callerApprovalPath,
      booking: f.path, cancellation: f.path, rescheduling: f.path },
    classAttendance: { approvalPath: c.classApprovalPath, practitionerId: c.cliniko.practitionerId, appointmentTypeId: c.cliniko.appointmentTypeId,
      bookPermission: c.classPermission, cancelPermission: c.classPermission, ...(c.classPassAuthority ? { passAuthority: c.classPassAuthority } : {}) } };
  const pending = () => { assert.ok(f.host.financial); return f.host.financial; };
  const readback = async () => { for (let i = 0; i < 16 && pending().inputAdmission()?.phase === "unplayed"; i++) await pending().acceptDigit("1", pending().inputAdmission()); };
  const accept = () => pending().acceptDigit("1", pending().inputAdmission());
  const confirm = async () => {
    let result = await f.confirm();
    const state = value(result), notice = state.pendingPresentationId ? state.presentations[state.pendingPresentationId] : undefined;
    if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
      await f.play(); await f.pause(notice.confirmationWaitSeconds + 1); result = await f.confirm();
    }
    return result;
  };
  const proof = () => {
    const source = [...funding.rows.values()].find(r => String(r.notes).includes("financial intent"))!;
    const intent = value(decodeClinikoFinancialIntent(source.notes));
    const observed = [...funding.rows.values()].find(r => String(r.notes).includes("financial booking observation"))!;
    return value(verifyFinancialBookingObservation(observed.notes, { intent, intentRecallRef: `cliniko:recall:${source.id}`, producerKeyRef: keyRef, publicKey: keys.publicKey }));
  };
  return { ...f, flowConfig, funding, config, financialLife, events, texts, selections, pending, readback, accept, confirm, proof,
    denyFinancial: () => { allowed = false; funding.deny(); }, close: async () => { financialLife.abort(); await f.close(); } };
}
