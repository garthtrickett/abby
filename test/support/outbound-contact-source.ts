import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClinikoOutboundContactSource, contactSourceSelection } from "../../src/cliniko/outbound-contact-source.ts";
import type { OutboundContactAuthority, OutboundContactQuery, OutboundContactSourceConfig } from "../../src/cliniko/outbound-contact-source.ts";
import type { OutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { encodeOutboundContactReview, outboundContactReviewDigest } from "../../src/cliniko/outbound-contact-review.ts";
import { OwnerFileOutboundContactSource } from "../../src/standalone/owner-file-outbound-contact-source.ts";
import type { OutboundContactSourceApproval } from "../../src/standalone/owner-file-outbound-contact-source.ts";
import type { AdminAccount, AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { value } from "./outbound-records.ts";
export async function outboundContactSourceFixture() {
  const request = { ...outboundRequestValue(), credentialFingerprint: clinikoCredentialFingerprint("synthetic-key-au5") };
  const folder = await mkdtemp(join(tmpdir(), "abby-contact-source-")), path = join(folder, "source.json");
  const state = { now: "2026-11-02T00:00:00.000Z", live: true, revision: 1, revisionBlocked: false, claims: 0,
    account: { email: "reviewer@example.invalid", membershipVersion: "1", actor: { actorRef: "contact-admin", role: "clinicAdmin", scope: request.scope } } as AdminAccount | undefined };
  const directory: AdminDirectory = { findByRef: async () => ({ ok: true, value: state.account }), findByEmail: async () => ({ ok: true, value: state.account }) };
  const config: OutboundContactSourceConfig = { scope: request.scope, apiKey: "synthetic-key-au5", contactEmail: "test@example.invalid", businessId: request.businessId,
    contactReviewRecallTypeId: "91", contactPolicyVersion: "contact-v1", contactPolicyDigest: "c".repeat(64), countryCallingCode: "61", clock: () => state.now,
    rateBudget: { claim: () => { state.claims++; return null; }, observe429: () => ({ kind: "rateLimited", resetAt: "2026-11-02T00:01:00.000Z" }) },
    contactRevision: { matches: (tenant, credential) => tenant === request.scope.tenantId && credential === request.credentialFingerprint,
      read: async () => ({ ok: true, value: { version: state.revision, blocked: state.revisionBlocked } }) } };
  const { scope: _, ...source } = contactSourceSelection(config);
  const approval: OutboundContactSourceApproval = { scope: request.scope, revision: "source-v1", approverRef: "contact-admin", approvedAt: "2026-11-01T00:00:00.000Z",
    effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z", approved: true, enabled: true, source };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const definitionConfig = { path, scope: request.scope, directory, clock: () => state.now }, definition = value(await OwnerFileOutboundContactSource.capture(definitionConfig, new AbortController().signal));
  const first: OutboundContactReview = { actionRef: randomUUID(), approvalRef: randomUUID(), reviewerRef: "contact-admin", scope: request.scope,
    businessId: config.businessId, credentialFingerprint: request.credentialFingerprint, contactRecallTypeId: config.contactReviewRecallTypeId,
    policy: { version: config.contactPolicyVersion, digest: config.contactPolicyDigest }, patientId: request.patientId, recipient: request.recipient,
    purposes: ["followUp", "sickDay"], consent: "granted", doNotCall: "clear", revision: 1, predecessor: null, reconsentApprovalRef: null,
    reviewedAt: "2026-11-01T00:00:00.000Z", effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" };
  const base = "https://api.au5.cliniko.com/v1";
  const row = (review: OutboundContactReview, id = "101"): Record<string, unknown> => ({ id, notes: value(encodeOutboundContactReview(review)), recall_at: "2026-11-01",
    created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", recalled: false, recalled_at: null, archived_at: null,
    links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${review.patientId}` } }, recall_type: { links: { self: `${base}/recall_types/${review.contactRecallTypeId}` } } });
  const controls: { rows: Record<string, unknown>[]; total?: number; patient: Record<string, unknown>;
    page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response>;
    get?: (row: Record<string, unknown>) => Response | Promise<Response>;
    phone?: () => Response | Promise<Response>; allow?: (q: OutboundContactQuery) => boolean | Promise<boolean> } = {
    rows: [row(first)], patient: { id: request.patientId, archived_at: null, merged_at: null, updated_at: "2026-11-01T00:00:00.000Z", links: { self: `${base}/patients/${request.patientId}` },
      patient_phone_numbers: [{ number: request.recipient.number, phone_type: "Mobile" }] } };
  const queries: OutboundContactQuery[] = [], calls: URL[] = [];
  const authority: OutboundContactAuthority = { allows: async q => { queries.push(q); return controls.allow ? controls.allow(q) : true; }, current: () => state.live };
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url); assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error"); assert.equal(init.body, undefined);
    if (url.pathname.startsWith("/v1/patients/")) { assert.equal(url.pathname, `/v1/patients/${request.patientId}`); return controls.phone ? controls.phone() : Response.json(controls.patient); }
    assert.deepEqual(url.searchParams.getAll("q[]"), url.pathname === "/v1/recalls" ? [`patient_id:=${request.patientId}`, "archived_at:*"] : ["archived_at:*"]);
    if (url.pathname === "/v1/recalls") {
      assert.equal(url.searchParams.get("sort"), "id:asc"); assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page")), rows = controls.rows.slice((page - 1) * 100, page * 100);
      return controls.page ? controls.page(rows, page) : Response.json({ recalls: rows, total_entries: controls.total ?? controls.rows.length });
    }
    const found = controls.rows.find(r => r.id === url.pathname.split("/").at(-1)); assert.ok(found);
    return controls.get ? controls.get(found) : Response.json(found);
  };
  const make = () => ClinikoOutboundContactSource.create(config, definition, authority, port);
  return { request, config, approval, definition, definitionConfig, directory, state, controls, queries, calls, first, row, port, authority, make,
    read: (signal = new AbortController().signal) => value(make()).readCurrentForRequest(request, signal),
    replace: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch })), close: () => rm(folder, { recursive: true, force: true }),
    next: (previous: OutboundContactReview, changes: Partial<OutboundContactReview> = {}): OutboundContactReview => ({ ...previous, actionRef: randomUUID(), approvalRef: randomUUID(),
      revision: previous.revision + 1, predecessor: { actionRef: previous.actionRef, digest: outboundContactReviewDigest(previous)! }, reconsentApprovalRef: null, ...changes }) };
}
