import { generateKeyPairSync, sign } from "node:crypto";
import { fixture as retention, value, uuid, base } from "./financial-retention.ts";
import { financialSourceApprovalFixture } from "./financial-source-approval.ts";
import { financialSourceSelection, OwnerFileFinancialSource } from "../../src/standalone/owner-file-financial-source.ts";
import { ApprovedFinancialWaiverIssuer, financialWaiverContentPolicy } from "../../src/standalone/approved-financial-waiver-issuer.ts";
import { financialWaiverPayload, financialWaiverMessage, formatFinancialWaiverDecision } from "../../src/cliniko/financial-waiver-decision.ts";
import type { FinancialWaiverDecision } from "../../src/cliniko/financial-waiver-decision.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { ClinikoFinancialWaiverReader } from "../../src/cliniko/financial-waiver-read.ts";
import type { FinancialWaiverBinding, FinancialWaiverReadAuthority } from "../../src/cliniko/financial-waiver-read.ts";
import type { ClinikoFinancialReviewConfig } from "../../src/cliniko/financial-review-read.ts";

export const waiverKeys = generateKeyPairSync("ed25519"), issuerKey = Object.freeze({ keyRef: "fixture-waiver-issuer", publicKey: waiverKeys.publicKey });
export function waiverFixture() {
  const f = retention(), expected = { intent: f.intent, intentRecallRef: "cliniko:recall:30", waiverRecallRef: "cliniko:recall:71", targetRef: "cliniko:appointment:91" };
  const decision: FinancialWaiverDecision = { actionRef: uuid(80), financialActionRef: f.intent.actionRef, intentRecallRef: expected.intentRecallRef,
    waiverRecallRef: expected.waiverRecallRef, intentDigest: financialIntentDigest(f.intent)!, targetRef: expected.targetRef, amount: f.intent.payment.amount, currency: f.intent.payment.currency,
    approvedAt: "2026-11-01T09:30:00.000Z", expiresAt: "2026-11-02T01:00:00.000Z", issuerKeyRef: issuerKey.keyRef };
  const format = (d: FinancialWaiverDecision = decision, key = waiverKeys.privateKey) => {
    const payload = financialWaiverPayload(d); if (!payload) throw new Error("Invalid fixture decision");
    const notes = formatFinancialWaiverDecision(d, sign(null, financialWaiverMessage(payload), key).toString("base64url"));
    if (!notes) throw new Error("Invalid fixture envelope"); return notes;
  };
  return { ...f, expected, decision, format };
}
export async function nativeWaiverFixture() {
  const approval = await financialSourceApprovalFixture(), f = waiverFixture();
  const config = { ...approval.native, clock: () => approval.state.now };
  const selection = value(financialSourceSelection({ ...config, producer: issuerKey }, financialWaiverContentPolicy));
  const { scope: _scope, ...source } = selection;
  await approval.replace({ source });
  const definition = value(await OwnerFileFinancialSource.capture(approval.config, new AbortController().signal));
  const issuer = value(ApprovedFinancialWaiverIssuer.create(config, issuerKey, definition));
  const state = { allowed: true, current: true, gets: 0, quota: 0 };
  config.rateBudget = { claim: async () => { state.quota++; return null; }, checkHeadroom: async () => null, observe429: async () => ({ kind: "rateLimited" as const }) };
  const binding: FinancialWaiverBinding = { ...f.expected, waiverRecallRef: "cliniko:recall:71", decisionRef: f.decision.actionRef };
  const row = { id: "71", links: { self: `${base}/recalls/71` }, patient: { links: { self: `${base}/patients/${f.intent.patientId}` } },
    recall_type: { links: { self: `${base}/recall_types/${config.recallTypeId}` } }, recalled: false, recalled_at: null, archived_at: null,
    recall_at: "2026-11-02", created_at: f.decision.approvedAt, updated_at: f.decision.approvedAt, notes: f.format(), private_context: "private-native-chart" };
  const queries: unknown[] = [];
  const authority: FinancialWaiverReadAuthority = { allows: async q => { queries.push(q); return state.allowed; }, current: () => state.current };
  const port: typeof fetch = async (input, init) => {
    assertRequest(input, init); state.gets++; return Response.json(row);
  };
  function assertRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
    if (String(input) !== `${base}/recalls/71` || init?.method !== "GET" || init.redirect !== "error") throw new Error("Unexpected private fixture request");
  }
  const create = (transport = port, grants = authority, settings: ClinikoFinancialReviewConfig = config) =>
    value(ClinikoFinancialWaiverReader.create(settings, issuer, grants, transport));
  return { ...approval, ...f, config, issuer, definition, selection, state, sourceState: approval.state, binding, row, queries, authority, port, create,
    withdraw: () => approval.replace({ source, enabled: false }), close: approval.close };
}
