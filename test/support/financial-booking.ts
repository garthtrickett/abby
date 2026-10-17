import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { standaloneBookingFixture } from "./standalone-booking.ts";
import { verificationNow } from "./caller-verification.ts";
import { keys, keyRef, value } from "./financial-retention.ts";
import type { FinancialBookingAssessment, FinancialBookingPreparationConfig } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";

export async function financialBookingFixture(options: { scope?: import("../../src/core/model.ts").LocationScope; barrierFor?: (native: FinancialBookingPreparationConfig["native"]) => FinancialBookingPreparationConfig["barrier"]; onObservation?: () => void; activate?: boolean; required?: boolean; play?: FinancialBookingPreparationConfig["presentation"]["play"];
  lostObservation?: boolean; lostIntent?: boolean; observationResponse?: (row: Record<string, unknown>) => Response;
  quote?: (q: FinancialBookingAssessment) => FinancialBookingAssessment | undefined } = {}) {
  const rows = new Map<string, Record<string, unknown>>(), texts: string[] = [], events: string[] = [], burned = new Set<string>();
  const financialLife = new AbortController(); let allowed = true, live = true, next = 100;
  let config: FinancialBookingPreparationConfig;
  const f = await standaloneBookingFixture({ ...(options.scope ? { scope: options.scope } : {}), ...(options.activate === undefined ? {} : { activate: options.activate }), fetchAround: port => async (input, init) => {
    const url = new URL(String(input));
    const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/recalls" && body?.recall_type_id === "40") {
      events.push("financial:POST"); const id = String(next++), row = { id, links: { self: `${url.origin}/v1/recalls/${id}` },
        patient: { links: { self: `${url.origin}/v1/patients/${body.patient_id}` } }, recall_type: { links: { self: `${url.origin}/v1/recall_types/40` } },
        recall_at: body.recall_at, notes: body.notes, recalled: false, archived_at: null, created_at: verificationNow, updated_at: verificationNow };
      rows.set(id, row);
      if (options.lostIntent && String(row.notes).includes("financial intent")) throw new Error("Synthetic lost financial intent response");
      if (String(row.notes).includes("financial booking observation")) {
        options.onObservation?.();
        if (options.lostObservation) throw new Error("Synthetic lost observation response");
        if (options.observationResponse) return options.observationResponse(row);
      }
      return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/recalls" && init?.method === "GET" && url.searchParams.getAll("q[]").some(q => q.startsWith("patient_id:="))) {
      const all: Record<string, unknown>[] = [...rows.values(), ...f.recalls.map(r => ({ ...r, links: { self: `${url.origin}/v1/recalls/${r.id}` }, created_at: verificationNow, updated_at: verificationNow }))];
      all
        .sort((a, b) => Number(a.id) - Number(b.id));
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json({ total_entries: all.length, recalls: all.slice((page - 1) * 100, page * 100) });
    }
    const id = url.pathname.match(/^\/v1\/recalls\/([0-9]+)$/)?.[1];
    if (id && rows.has(id)) { events.push("financial:GET"); return Response.json(rows.get(id)); }
    events.push(`clinical:${init?.method ?? "GET"}:${url.pathname}`); return port(input, init);
  }, financialFor: (native, fetchPort) => {
    config = { native: { scope: native.scope, apiKey: native.apiKey, businessId: native.businessId, contactEmail: native.contactEmail,
      recallTypeId: "40", stripe: { accountRef: "acct_fixture", livemode: false }, producer: { keyRef, publicKey: keys.publicKey }, rateBudget: native.rateBudget, clock: () => verificationNow },
      privateKey: keys.privateKey, sourceAuthorized: async () => allowed,
      authority: { allows: async () => allowed, producerAdmitted: async () => allowed, current: () => live },
      barrier: { matches: () => true, claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } },
      financialSignal: financialLife.signal, fetchPort,
      policy: { quote: async selection => {
        const q: FinancialBookingAssessment = options.required === false ? { kind: "notRequired", version: "fee-none-1", expiresAt: selection.expiresAt } : {
          kind: "required", payment: { amount: 5000, currency: "gbp", policyVersion: "fee-policy-1", termsVersion: "financial-terms-1", deadline: "2026-10-05T04:00:00.000Z" },
          recipient: { kind: "email", address: "financial-recipient@example.invalid" }, approvedTerms: "The clinic will review late payment; no automatic refund is promised.", reviewDate: "2026-10-05", expiresAt: selection.expiresAt };
        return options.quote ? options.quote(q) : q;
      }, current: async () => { events.push("financial:permission"); return allowed; }, currentForSend: () => live },
      presentation: { play: async (text, signal, canPresent) => { texts.push(text); if (!canPresent()) return undefined; return options.play ? options.play(text, signal, canPresent) : { presentationRef: randomUUID(), playedAt: verificationNow }; } } };
    if (options.barrierFor) config = { ...config, barrier: options.barrierFor(config.native) };
    return config;
  } });
  const pending = () => { assert.ok(f.host.financial); return f.host.financial; };
  const playSegment = async () => pending().acceptDigit("1", pending().inputAdmission());
  const play = async () => {
    let result = await playSegment();
    for (let i = 0; pending().inputAdmission()?.phase === "unplayed" && i < 16; i++) result = await playSegment();
    assert.notEqual(pending().inputAdmission()?.phase, "unplayed");
    return result;
  };
  const accept = async () => pending().acceptDigit("1", pending().inputAdmission());
  const proof = () => {
    const intentRow = [...rows.values()].find(r => String(r.notes).includes("financial intent")); assert.ok(intentRow);
    const intent = value(decodeClinikoFinancialIntent(intentRow.notes));
    const row = [...rows.values()].find(r => String(r.notes).includes("financial booking observation")); assert.ok(row);
    return value(verifyFinancialBookingObservation(row.notes, { intent, intentRecallRef: `cliniko:recall:${intentRow.id}`, producerKeyRef: keyRef, publicKey: keys.publicKey }));
  };
  return { ...f, config: config!, rows, texts, events, burned, financialLife, pending, play, playSegment, accept, proof,
    get posts() { return f.posts; }, denyFinancial: () => { allowed = false; }, withdrawFinancial: () => { live = false; } };
}
