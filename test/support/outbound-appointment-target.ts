import assert from "node:assert/strict";
import { ClinikoOutboundAppointmentTarget } from "../../src/cliniko/outbound-appointment-target.ts";
import type { OutboundTargetAuthority, OutboundTargetConfig, OutboundTargetQuery } from "../../src/cliniko/outbound-appointment-target.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { value } from "./outbound-records.ts";

export function outboundTargetFixture(options: {
  Reader?: typeof ClinikoOutboundAppointmentTarget; apiKey?: string; budget?: ClinikoRequestBudget;
  authority?: Partial<OutboundTargetAuthority>; deadlineMs?: number;
  response?(row: Record<string, unknown>, signal: AbortSignal): Response | Promise<Response>;
  claim?(): Promise<null | { kind: "rateLimited" }>;
} = {}) {
  const base = "https://api.au5.cliniko.com/v1", apiKey = options.apiKey ?? "synthetic-target-au5";
  let now = "2026-11-01T10:00:00.000Z", live = true, allowed = true, claims = 0, fetches = 0;
  const input = { patientId: "21", appointmentRef: "cliniko:appointment:71" };
  const request = { ...outboundRequestValue(), credentialFingerprint: clinikoCredentialFingerprint(apiKey) };
  const row: Record<string, unknown> = { id: "71", links: { self: `${base}/individual_appointments/71` },
    patient: { links: { self: `${base}/patients/21` } }, business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/31` } }, appointment_type: { links: { self: `${base}/appointment_types/41` } },
    starts_at: "2026-11-02T10:00:00.000001+11:00", ends_at: "2026-11-02T10:30:00.000001+11:00",
    created_at: "2026-10-01T00:00:00.000001Z", updated_at: "2026-10-02T00:00:00.000001Z",
    archived_at: null, cancelled_at: null, deleted_at: null, did_not_arrive: null, patient_arrived: false,
    notes: "discard-private-native-target-note", patient_name: "discard-private-native-target-name" };
  const queries: OutboundTargetQuery[] = [];
  const config: OutboundTargetConfig = { appointmentPolicyDigest: "e".repeat(64), requests: {
    scope: request.scope, businessId: request.businessId, apiKey, contactEmail: "clinic@example.invalid",
    outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), clock: () => now,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    rateBudget: { claim: async () => { claims++; return options.budget ? options.budget.claim() : options.claim ? options.claim() : null; },
      observe429: async reset => options.budget ? options.budget.observe429(reset) : ({ kind: "rateLimited" }) } } };
  const authority: OutboundTargetAuthority = { allows: async q => { queries.push(q); return allowed; }, current: () => live, ...options.authority };
  const port: typeof fetch = async (url, init) => {
    assert.equal(String(url), `${base}/individual_appointments/71`); assert.ok(init); assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error"); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    fetches++; return options.response ? options.response(row, init.signal!) : Response.json(row);
  };
  const make = () => (options.Reader ?? ClinikoOutboundAppointmentTarget).create(config, authority, port), reader = value(make());
  return { reader, config, authority, port, request, input, row, queries, make,
    get claims() { return claims; }, get fetches() { return fetches; },
    deny: () => { allowed = false; }, retire: () => { live = false; }, setNow: (at: string) => { now = at; },
    observe: (signal = new AbortController().signal) => reader.observeTarget(input, signal) };
}
