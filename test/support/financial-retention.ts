import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialRecordAuthority, FinancialRecordRetentionConfig } from "../../src/cliniko/financial-record-retention.ts";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { financialBookingObservationPayload, financialBookingObservationMessage, formatFinancialBookingObservation, financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { FinancialEffectBarrier } from "../../src/standalone/financial-effect-barrier.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" };
const apiKey = "synthetic-retention-au5", base = "https://api.au5.cliniko.com/v1";
const keys = generateKeyPairSync("ed25519"), keyRef = "fixture-producer-1", now = "2026-11-01T10:00:00.000Z", reviewDate = "2026-11-02";
const stop = () => new AbortController().signal;
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T { assert.ok(r.ok, JSON.stringify(r)); return r.value; }
function intentValue(): ClinikoFinancialIntent {
  return { actionRef: uuid(1), scope, patientId: "21", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
    booking: { kind: "book", actionRef: uuid(2), practitionerId: "12", appointmentTypeId: "13", startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T09:30:00.000Z" },
    stripe: { accountRef: "acct_fixture", livemode: false },
    payment: { amount: 5000, currency: "gbp", policyVersion: "fees-1", termsVersion: "terms-1", deadline: "2026-11-02T08:00:00.000Z" },
    recipient: { kind: "email", address: "private-retention@example.invalid" },
    effects: { checkout: uuid(3), linkDelivery: uuid(4), receiptDelivery: uuid(5), checkoutExpiry: uuid(6), clinicalExpiry: uuid(7) }, createdAt: "2026-11-01T09:00:00.000Z" };
}
function observation(intent = intentValue(), intentRecallRef = "cliniko:recall:30") {
  const row = { actionRef: uuid(8), financialActionRef: intent.actionRef, intentRecallRef, intentDigest: financialIntentDigest(intent)!,
    bookingActionRef: intent.booking.actionRef, targetRef: "cliniko:appointment:91", observedAt: now, producerKeyRef: keyRef };
  return formatFinancialBookingObservation(row, sign(null, financialBookingObservationMessage(financialBookingObservationPayload(row)!), keys.privateKey).toString("base64url"))!;
}
type Row = Record<string, unknown>;
function fixture(options: { intent?: ClinikoFinancialIntent; barrierFactory?: (config: FinancialRecordRetentionConfig) => FinancialEffectBarrier; config?: Partial<FinancialRecordRetentionConfig>; response?: (row: Row, method: string) => Response | Promise<Response>;
  quota?: () => Promise<null>; claim?: () => Promise<{ ok: true; value: { claimed: boolean } }>; authority?: Partial<FinancialRecordAuthority> } = {}) {
  const intent = options.intent ?? intentValue(), events: string[] = [], queries: unknown[] = [], rows = new Map<string, Row>(), burned = new Set<string>();
  let allowed = true, admitted = true, current = true, next = 30;
  const config: FinancialRecordRetentionConfig = { scope: intent.scope, apiKey, contactEmail: "clinic@example.invalid", businessId: "11", recallTypeId: "40",
    stripe: intent.stripe, producer: { keyRef, publicKey: keys.publicKey }, clock: () => now,
    rateBudget: { claim: async () => { events.push("quota"); return options.quota ? options.quota() : null; }, observe429: async () => ({ kind: "rateLimited" as const }) }, ...options.config };
  const binding = value(financialRecordOwnerBinding(config));
  const barrier: FinancialEffectBarrier = options.barrierFactory?.(config) ?? { matches: (s, b) => JSON.stringify(s) === JSON.stringify(scope) && b === binding,
    claimOnce: async ref => { events.push("claim"); if (options.claim) return options.claim(); const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } };
  const authority: FinancialRecordAuthority = { allows: async q => { events.push("role"); queries.push(q); return allowed; },
    producerAdmitted: async () => { events.push("producer"); return admitted; }, current: () => { events.push("current"); return current; }, ...options.authority };
  const nativeKey = config.apiKey;
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from(`${nativeKey}:`).toString("base64")}`);
    events.push(method);
    let row: Row;
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/recalls"); const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body).sort(), ["notes", "patient_id", "recall_at", "recall_type_id", "recalled"]);
      const id = String(next++); row = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
        recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } }, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: now, updated_at: now, private_unknown: "private-native-record-canary" };
      rows.set(id, row);
    } else { assert.equal(method, "GET"); row = rows.get(url.pathname.split("/").at(-1)!)!; }
    return options.response ? options.response(row, method) : Response.json(row, { status: method === "POST" ? 201 : 200 });
  };
  const seedIntent = () => {
    if (rows.has("30")) return;
    rows.set("30", { id: "30", links: { self: `${base}/recalls/30` }, patient: { links: { self: `${base}/patients/${intent.patientId}` } },
      recall_type: { links: { self: `${base}/recall_types/${config.recallTypeId}` } }, notes: value(encodeClinikoFinancialIntent(intent)), recall_at: reviewDate,
      recalled: false, recalled_at: null, archived_at: null, created_at: now, updated_at: now });
    next = Math.max(next, 31);
  };
  const made = ClinikoFinancialRecordRetainer.create(config, authority, barrier, port);
  return { retainer: value(made), intent, config, authority, barrier, port, events, queries, rows, burned, seedIntent,
    deny: () => { allowed = false; }, unadmit: () => { admitted = false; }, expire: () => { current = false; }, allow: () => { allowed = true; } };
}

export { uuid, scope, apiKey, base, keys, keyRef, now, reviewDate, stop, value, intentValue, observation, fixture };
