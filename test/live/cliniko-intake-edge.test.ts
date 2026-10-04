import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoPatientIntakeEdge } from "../../src/cliniko/patient-intake.ts";
import type { ClinikoIntakeRequest } from "../../src/cliniko/patient-intake.ts";
import { TransientIntakeAuthority } from "../../src/standalone/transient-intake-authority.ts";
import type { HostIntakeEvidence } from "../../src/standalone/transient-intake-authority.ts";
import { err, ok } from "../../src/core/model.ts";

type Patient = Readonly<{ firstName: string; lastName: string; email: string;
  dateOfBirth: string; patientPhone: string; phoneType: "Mobile" }>;
type Fixture = { patient: Patient; id: string | undefined; attempted: boolean; archived: boolean };
type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function patientId(value: unknown): string | undefined {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value : undefined;
}

/** Demo-only: every mutation uses a unique synthetic fixture and is verified archived. */
test("C-LIVE-39 disconnected intake edge creates once, rejects duplicate and revoked consent, and fences a lost response",
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
  const scope = { tenantId: `intake-${marker}`, clinicId: "demo", locationId: "frontdesk" };
  const sharedEmail = `abby-intake+${marker}@example.test`;
  const dateOfBirth = "1990-05-21";
  const phone = `+614559${randomInt(10_000, 100_000)}`;
  const fixtures: Fixture[] = [
    { patient: { firstName: "Abby", lastName: `SyntheticIntake${marker.slice(0, 16)}`,
      email: sharedEmail, dateOfBirth, patientPhone: phone, phoneType: "Mobile" }, id: undefined, attempted: false, archived: false },
    { patient: { firstName: "Abby", lastName: `SyntheticHousehold${marker.slice(0, 16)}`,
      email: sharedEmail, dateOfBirth, patientPhone: phone, phoneType: "Mobile" }, id: undefined, attempted: false, archived: false },
    { patient: { firstName: "Abby", lastName: `SyntheticLost${marker.slice(0, 16)}`,
      email: `abby-intake-lost+${marker}@example.test`, dateOfBirth, patientPhone: phone,
      phoneType: "Mobile" }, id: undefined, attempted: false, archived: false },
  ];
  const interrupted: Patient = { firstName: "Abby", lastName: `SyntheticRevoked${marker.slice(0, 16)}`,
    email: `abby-intake-revoked+${marker}@example.test`, dateOfBirth, patientPhone: phone, phoneType: "Mobile" };

  async function request(method: "GET" | "POST", path: string, body?: Json): Promise<{ status: number; body: Json }> {
    const response = await fetch(`${base}${path}`, { method, headers, redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const raw = await response.text();
    if (raw.length > 100_000) throw new Error("oversized demo response");
    return { status: response.status, body: raw ? record(JSON.parse(raw)) ?? {} : {} };
  }

  async function matchingIds(patient: Patient): Promise<string[]> {
    const query = new URLSearchParams({ page: "1", per_page: "100" });
    query.append("q[]", `email:=${patient.email}`);
    query.append("q[]", `date_of_birth:=${patient.dateOfBirth}`);
    const found = await request("GET", `/patients?${query}`);
    if (found.status !== 200 || !Array.isArray(found.body.patients) || found.body.total_entries !== found.body.patients.length)
      throw new Error("synthetic patient reconciliation unavailable");
    const possible = found.body.patients.map(record).filter(row => row?.first_name === patient.firstName &&
      row.last_name === patient.lastName && row.email === patient.email &&
      row.date_of_birth === patient.dateOfBirth && row.archived_at === null)
      .map(row => patientId(row?.id)).filter((id): id is string => !!id);
    const exact: string[] = [];
    for (const id of possible) {
      const detail = await request("GET", `/patients/${id}`);
      if (detail.status === 200 && detail.body.id === id && detail.body.first_name === patient.firstName &&
          detail.body.last_name === patient.lastName && detail.body.email === patient.email &&
          detail.body.date_of_birth === patient.dateOfBirth && detail.body.archived_at === null &&
          Array.isArray(detail.body.patient_phone_numbers) && detail.body.patient_phone_numbers.some(number =>
            record(number)?.number === patient.patientPhone)) exact.push(id);
    }
    return exact;
  }

  function host(patient: Patient, revokeOnRead = false) {
    const callId = `call:${randomUUID()}`;
    const sessionId = `session:${randomUUID()}`;
    const refs = { draftRef: `draft:${randomUUID()}`, consentRef: `consent:${randomUUID()}`,
      authorityRef: `authority:${randomUUID()}` };
    let consent = true;
    const evidence: HostIntakeEvidence = { scope, callId, sessionId, policyVersion: "demo-intake-v1",
      ...refs, draft: patient, caller: "patient", privacyAccepted: true, proxyAuthorized: false,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    const authority = new TransientIntakeAuthority({ scope, callId, sessionId,
      policyVersion: evidence.policyVersion, source: { async resolve() {
        return consent ? ok(evidence) : err({ kind: "denied" });
      } } });
    return { authority, refs, revoke: () => { if (revokeOnRead) consent = false; } };
  }

  async function prepared(instance: ReturnType<typeof host>): Promise<ClinikoIntakeRequest> {
    const result = await instance.authority.prepare(instance.refs.draftRef, instance.refs.consentRef,
      instance.refs.authorityRef);
    assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
    return result.value;
  }

  function edge(instance: ReturnType<typeof host>, fetchPort: typeof fetch) {
    const created = ClinikoPatientIntakeEdge.create({ scope, countryCallingCode: "61", apiKey, contactEmail }, instance.authority, fetchPort);
    assert.equal(created.ok, true, created.ok ? "" : created.error.kind);
    return created.value;
  }

  function observedFetch(fixture: Fixture, losePostResponse = false): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(base).origin);
      assert.ok(url.pathname === "/v1/patients" || (init?.method === "GET" && fixture.id && url.pathname === `/v1/patients/${fixture.id}`));
      if (init?.method === "POST") fixture.attempted = true;
      const response = await fetch(input, init);
      if (init?.method === "POST") {
        const row = record(await response.clone().json());
        fixture.id = patientId(row?.id);
        if (losePostResponse) throw new Error("injected completed POST response loss");
      }
      return response;
    };
  }

  const cleanupFailures: string[] = [];
  try {
    const first = host(fixtures[0]!.patient);
    const created = await edge(first, observedFetch(fixtures[0]!)).createOnce(await prepared(first));
    assert.equal(created.ok, true, created.ok ? "" : created.error.kind);
    assert.equal(created.value.kind, "created");
    assert.ok(fixtures[0]!.id && created.value.patientRef === `cliniko:patient:${fixtures[0]!.id}`);
    first.authority.dispose();

    const duplicate = host(fixtures[0]!.patient);
    const duplicateResult = await edge(duplicate, async (input, init) => {
      assert.equal(init?.method, "GET");
      return fetch(input, init);
    }).createOnce(await prepared(duplicate));
    assert.equal(duplicateResult.ok, true, duplicateResult.ok ? "" : duplicateResult.error.kind);
    assert.equal(duplicateResult.value.kind, "existingCandidate");
    duplicate.authority.dispose();

    const household = fixtures[1]!;
    household.attempted = true;
    const second = await request("POST", "/patients", { first_name: household.patient.firstName,
      last_name: household.patient.lastName, email: household.patient.email,
      date_of_birth: household.patient.dateOfBirth,
      patient_phone_numbers: [{ number: household.patient.patientPhone, phone_type: "Mobile" }],
      accepted_privacy_policy: true });
    household.id = patientId(second.body.id);
    assert.equal(second.status, 201);
    assert.ok(household.id);
    const ambiguous = host(fixtures[0]!.patient);
    const ambiguousResult = await edge(ambiguous, async (input, init) => {
      assert.equal(init?.method, "GET");
      return fetch(input, init);
    }).createOnce(await prepared(ambiguous));
    assert.equal(ambiguousResult.ok, true, ambiguousResult.ok ? "" : ambiguousResult.error.kind);
    assert.equal(ambiguousResult.value.kind, "ambiguous");
    ambiguous.authority.dispose();

    const revoked = host(interrupted, true);
    const revokedRequest = await prepared(revoked);
    const revokedResult = await edge(revoked, async (input, init) => {
      assert.equal(init?.method, "GET");
      const response = await fetch(input, init);
      revoked.revoke();
      return response;
    }).createOnce(revokedRequest);
    assert.equal(revokedResult.ok, false);
    assert.equal(revokedResult.error.kind, "unauthorized");
    revoked.authority.dispose();

    const lost = host(fixtures[2]!.patient);
    const lostEdge = edge(lost, observedFetch(fixtures[2]!, true));
    const lostRequest = await prepared(lost);
    const uncertain = await lostEdge.createOnce(lostRequest);
    assert.equal(uncertain.ok, true, uncertain.ok ? "" : uncertain.error.kind);
    assert.equal(uncertain.value.kind, "uncertain");
    const repeated = await lostEdge.createOnce(lostRequest);
    assert.equal(repeated.ok, false);
    assert.equal(repeated.error.kind, "invalidQuery");
    lost.authority.dispose();
    assert.equal((await matchingIds(fixtures[2]!.patient)).length, 1);
  } finally {
    for (const fixture of fixtures.filter(item => item.attempted)) {
      try {
        const matches = await matchingIds(fixture.patient);
        if (matches.length !== 1 || (fixture.id && fixture.id !== matches[0])) {
          cleanupFailures.push("patient reconciliation uncertain");
          continue;
        }
        const id = matches[0]!;
        const archived = await request("POST", `/patients/${id}/archive`);
        const verified = await request("GET", `/patients/${id}?q%5B%5D=archived_at%3A*`);
        fixture.archived = archived.status === 204 && verified.status === 200 &&
          verified.body.id === id && !!verified.body.archived_at;
        if (!fixture.archived) cleanupFailures.push("patient archive unverified");
      } catch { cleanupFailures.push("patient cleanup unavailable"); }
    }
    if (cleanupFailures.length) throw new Error(`Cliniko demo cleanup uncertain: ${cleanupFailures.join(", ")}`);
  }
  assert.ok(fixtures.every(item => item.attempted && item.archived));
  process.stdout.write("Cliniko demo intake: created receipt, existing and ambiguous candidates, revoked consent, " +
    "completed POST response loss with no retry; 3 synthetic patients archived and verified\n");
});
