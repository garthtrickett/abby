import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeOptions } from "../../src/cliniko/patient-intake.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { err, ok } from "../../src/core/model.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence } from "../../src/standalone/transient-intake-authority.ts";

export const intakeNow = "2026-10-04T12:00:00.000Z";
export const intakeDraft = { firstName: "PrivateIntakeCanary", lastName: "SyntheticCaller",
  email: "private-intake-canary@example.test", dateOfBirth: "1987-06-21", patientPhone: "+61400111222", phoneType: "Mobile" as const };
export const intakeCredential = "synthetic-intake-edge-secret-au5";
type Row = Record<string, unknown>;
export type IntakeProviderHook = (method: string, path: string, signal: AbortSignal, body: Row | undefined) =>
  Response | undefined | Promise<Response | undefined>;

/** Actual transient authority and provider edge; the remote records/approvals alone are synthetic. */
export async function intakeEdgeFixture(budget: ClinikoRequestBudget = new ClinikoReadBudget()) {
  const scope = { tenantId: `intake-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const callId = `call:${randomUUID()}`, sessionId = `session:${randomUUID()}`;
  const refs = { draftRef: `draft:${randomUUID()}`, consentRef: `consent:${randomUUID()}`, authorityRef: `authority:${randomUUID()}` };
  let evidence: HostIntakeEvidence | null = { scope, callId, sessionId, policyVersion: "intake-policy:1", ...refs,
    draft: intakeDraft, caller: "patient", privacyAccepted: true, proxyAuthorized: false,
    expiresAt: "2026-10-04T12:05:00.000Z" };
  let evidenceHook: (() => Promise<void>) | undefined, providerHook: IntakeProviderHook | undefined;
  const lifetime = new AbortController();
  const authority = new TransientIntakeAuthority({ scope, callId, sessionId, policyVersion: "intake-policy:1",
    clock: () => intakeNow, source: { async resolve(query) {
      await evidenceHook?.();
      if (query.signal.aborted || !evidence) return err({ kind: "denied" });
      assert.equal(query.callId, callId); assert.equal(query.sessionId, sessionId);
      assert.deepEqual([query.draftRef, query.consentRef, query.authorityRef], Object.values(refs));
      return ok(evidence);
    } } });
  const prepared = await authority.prepare(refs.draftRef, refs.consentRef, refs.authorityRef); assert.ok(prepared.ok);
  const traffic: string[] = [];
  let row: Row | undefined, posts = 0;
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.ok(init?.signal); assert.ok(!init.signal.aborted);
    traffic.push(`${method} ${url.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) as Row : undefined;
    const override = await providerHook?.(method, url.pathname, init.signal, body);
    if (override) return override;
    if (url.pathname === "/v1/patients" && method === "GET") {
      assert.deepEqual(url.searchParams.getAll("q[]"), [`email:=${intakeDraft.email}`, `date_of_birth:=${intakeDraft.dateOfBirth}`]);
      return Response.json({ total_entries: 0, patients: [] });
    }
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/patients"); assert.ok(body); posts++;
      row = { ...body, id: "42", archived_at: null, notes: "private provider chart canary" };
      return Response.json(row, { status: 201 });
    }
    assert.equal(method, "GET"); assert.equal(url.pathname, "/v1/patients/42"); assert.ok(row);
    return Response.json(row);
  };
  const edge = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey: intakeCredential,
    contactEmail: "owner@example.test", rateBudget: budget }, authority, fetchPort, () => intakeNow); assert.ok(edge.ok);
  return { scope, callId, sessionId, refs, authority, request: prepared.value, edge: edge.value, traffic,
    get posts() { return posts; }, get row() { return row; }, get evidence() { return evidence; },
    setEvidence(next: HostIntakeEvidence | null) { evidence = next; },
    holdEvidence(hook: typeof evidenceHook) { evidenceHook = hook; },
    intercept(hook: IntakeProviderHook | undefined) { providerHook = hook; },
    create(options: ClinikoIntakeOptions = {}) { return edge.value.createOnce(prepared.value,
      { ...options, signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal }); },
    close() { lifetime.abort(); authority.dispose(); } };
}

export function intakeDeferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(ready => { resolve = ready; });
  return { promise, resolve };
}
