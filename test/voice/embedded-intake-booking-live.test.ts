import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import { err, ok } from "../../src/core/model.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence } from "../../src/standalone/transient-intake-authority.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { scope, draftRef, runEmbeddedIntakeBookingCall as runCall } from "../support/embedded-intake-booking-call.ts";

test("C-LIVE-40 embedded voice keeps a real demo-created patient after synthetic booking rejection",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" || !process.env.ABBY_CLINIKO_API_KEY ||
    !process.env.ABBY_CLINIKO_CONTACT_EMAIL, timeout: 120_000 }, async () => {
  const apiKey = process.env.ABBY_CLINIKO_API_KEY!;
  const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
  const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
  assert.ok(shard);
  const base = `https://api.${shard}.cliniko.com/v1`;
  const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json", "User-Agent": `Abby (${contactEmail})` };
  const marker = randomUUID().replaceAll("-", "");
  const patient = { firstName: "Abby", lastName: `SyntheticVoice${marker.slice(0, 16)}`,
    email: `abby-intake-voice+${marker}@example.test`, dateOfBirth: "1990-05-21",
    patientPhone: `+614559${randomInt(10_000, 100_000)}`, phoneType: "Mobile" as const };
  let attempted = false;
  let responseId: string | undefined;

  async function request(method: "GET" | "POST", path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      const response = await fetch(`${base}${path}`, { method, headers, redirect: "error",
        signal: AbortSignal.timeout(15_000) });
      const raw = await response.text();
      if (raw.length > 100_000) throw new Error("oversized response");
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid response");
      return { status: response.status, body: parsed as Record<string, unknown> };
    } catch { throw new Error("Cliniko demo read or cleanup unavailable"); }
  }

  try {
    await runCall("rejected", false, false, async () => {
      const callId = callIdFor({ accountRef: "buyer-provider", providerCallRef: "intake-rejected" });
      const sessionId = "session-rejected";
      const refs = { draftRef, consentRef: `consent:${marker}`, authorityRef: `authority:${marker}` };
      const evidence: HostIntakeEvidence = { scope, callId, sessionId, policyVersion: "1", ...refs,
        draft: patient, caller: "patient", privacyAccepted: true, proxyAuthorized: false,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      const authority = new TransientIntakeAuthority({ scope, callId, sessionId, policyVersion: "1",
        source: { async resolve(query) {
          return query.callId === callId && query.sessionId === sessionId &&
            query.draftRef === draftRef && query.consentRef === refs.consentRef &&
            query.authorityRef === refs.authorityRef ? ok(evidence) : err({ kind: "denied" as const });
        } } });
      try {
        const prepared = await authority.prepare(refs.draftRef, refs.consentRef, refs.authorityRef);
        assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error.kind);
        const edge = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey, contactEmail }, authority,
          async (input, init) => {
            if (init?.method === "POST") attempted = true;
            const response = await fetch(input, init);
            if (init?.method === "POST") {
              const row: unknown = await response.clone().json();
              if (typeof row === "object" && row !== null && "id" in row &&
                  typeof row.id === "string" && /^[1-9][0-9]{0,18}$/.test(row.id)) responseId = row.id;
            }
            return response;
          });
        assert.equal(edge.ok, true, edge.ok ? "" : edge.error.kind);
        const created = await edge.value.createOnce(prepared.value);
        assert.equal(created.ok, true, created.ok ? "" : created.error.kind);
        if (created.value.kind !== "created") throw new Error("demo intake receipt unavailable");
        assert.ok(responseId && created.value.patientRef === `cliniko:patient:${responseId}`);
        return created.value.patientRef;
      } finally { authority.dispose(); }
    });
  } finally {
    if (attempted) {
      const query = new URLSearchParams({ page: "1", per_page: "2" });
      query.append("q[]", `email:=${patient.email}`);
      query.append("q[]", `date_of_birth:=${patient.dateOfBirth}`);
      const listed = await request("GET", `/patients?${query}`);
      const rows = listed.body.patients;
      if (listed.status !== 200 || !Array.isArray(rows) || listed.body.total_entries !== 1 || rows.length !== 1) {
        throw new Error("Cliniko demo patient cleanup reconciliation uncertain");
      }
      const candidate = rows[0] as Record<string, unknown>;
      const id = candidate.id;
      if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) ||
          (responseId && responseId !== id) || candidate.first_name !== patient.firstName ||
          candidate.last_name !== patient.lastName || candidate.email !== patient.email ||
          candidate.date_of_birth !== patient.dateOfBirth) {
        throw new Error("Cliniko demo patient cleanup identity uncertain");
      }
      const detail = await request("GET", `/patients/${id}`);
      const phones = detail.body.patient_phone_numbers;
      if (detail.status !== 200 || detail.body.id !== id || !Array.isArray(phones) ||
          !phones.some(value => typeof value === "object" && value !== null &&
            "number" in value && value.number === patient.patientPhone)) {
        throw new Error("Cliniko demo patient cleanup detail uncertain");
      }
      const archived = await request("POST", `/patients/${id}/archive`);
      const verified = await request("GET", `/patients/${id}?q%5B%5D=archived_at%3A*`);
      if (archived.status !== 204 || verified.status !== 200 || verified.body.id !== id ||
          !verified.body.archived_at) throw new Error("Cliniko demo patient archive unverified");
    }
  }
});
