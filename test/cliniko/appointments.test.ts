import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import type { AppointmentReadFailure, ClinikoAppointmentConfig } from "../../src/cliniko/appointments.ts";
import type { Result } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";

const scope = { tenantId: "appointment-tenant", clinicId: "appointment-clinic", locationId: "appointment-location" };
const config: ClinikoAppointmentConfig = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11" };
const now = "2026-09-28T10:00:00.000Z";
const from = "2026-09-28T10:00:00.000Z";
const to = "2026-10-05T10:00:00.000Z";
const patient = { scope, patientRef: "22", verificationRef: "host-proof", expiresAt: "2026-09-29T10:00:00.000Z" };
const host = new ReferenceClinicHost([patient], []);

function value<T>(result: Result<T, AppointmentReadFailure>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure<T>(result: Result<T, AppointmentReadFailure>, kind: AppointmentReadFailure["kind"]): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function appointment(id: string, options: Record<string, unknown> = {}) {
  return {
    id, starts_at: "2026-09-30T11:00:00Z", ends_at: "2026-09-30T11:30:00Z",
    patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } },
    business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
    cancelled_at: null, archived_at: null, deleted_at: null,
    patient_name: "Sensitive Name", notes: "Sensitive clinical note", ...options,
  };
}

function fakeProvider(pages: unknown[][], options: { status?: number; business?: unknown; total?: number } = {}) {
  const requests: URL[] = [];
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (dev@example.test)");
    if (url.pathname === "/v1/businesses/11") return new Response(JSON.stringify(options.business ??
      { id: "11", time_zone_identifier: "Australia/Sydney", archived_at: null }), { status: 200 });
    assert.equal(url.pathname, "/v1/individual_appointments");
    const page = Number(url.searchParams.get("page"));
    if (options.status) return new Response(null, { status: options.status });
    return new Response(JSON.stringify({ total_entries: options.total ?? pages.flat().length,
      individual_appointments: pages[page - 1] ?? [] }), { status: 200 });
  };
  return { port, requests };
}

function readerFor(proof: ReferenceClinicHost, port: typeof fetch): ClinikoAppointmentReader {
  return value(ClinikoAppointmentReader.create(config, proof, port, () => now));
}

test("verified patient proof yields only scoped, minimal future appointment data", async () => {
  const provider = fakeProvider([[appointment("33")]]);
  const reader = readerFor(host, provider.port);
  const read = value(await reader.list(scope, "host-proof", from, to, now));
  assert.deepEqual(read.appointments, [{ appointmentRef: "33", startsAt: "2026-09-30T11:00:00.000Z", endsAt: "2026-09-30T11:30:00.000Z" }]);
  assert.equal(read.timeZone, "Australia/Sydney");
  assert.equal(read.patientRef, "22");
  assert.equal(JSON.stringify(read).includes("Sensitive"), false);
  const query = provider.requests[1]!.searchParams;
  assert.deepEqual(query.getAll("q[]"), ["patient_id:=22", "business_id:=11", `starts_at:>${from}`, `starts_at:<${to}`]);
  assert.equal(query.get("per_page"), "100");
});

test("invalid runtime configuration returns a typed failure", () => {
  failure(ClinikoAppointmentReader.create({ ...config, apiKey: "invalid" }, host), "invalidConfig");
  failure(ClinikoAppointmentReader.create({ ...config, scope: { ...scope, locationId: "" } }, host), "invalidConfig");
});

test("unverified, expired, ambiguous, and foreign-scope proofs never reach Cliniko", async () => {
  const provider = fakeProvider([[appointment("33")]]);
  const reader = readerFor(host, provider.port);
  failure(await reader.list(scope, "unknown-proof", from, to, now), "invalidProof");
  failure(await reader.list(scope, " ", from, to, now), "invalidProof");
  failure(await reader.list({ ...scope, tenantId: "other" }, "host-proof", from, to, now), "scopeMismatch");
  failure(await reader.list(scope, "host-proof", "2026-09-27T10:00:00Z", to, now), "invalidRange");
  failure(await reader.list(scope, "host-proof", from, to, "2026-09-27T10:00:00Z"), "invalidRange");
  const expired = new ReferenceClinicHost([{ ...patient, expiresAt: now }], []);
  const duplicate = new ReferenceClinicHost([patient, { ...patient, patientRef: "23" }], []);
  failure(await readerFor(expired, provider.port).list(scope, "host-proof", from, to, now), "invalidProof");
  failure(await readerFor(duplicate, provider.port).list(scope, "host-proof", from, to, now), "invalidProof");
  assert.equal(provider.requests.length, 0);
});

test("provider rows cannot cross patient or business scope or leak a partial page", async () => {
  for (const row of [
    appointment("33", { patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/23" } } }),
    appointment("33", { business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/12" } } }),
    appointment("33", { starts_at: "2026-10-07T11:00:00Z" }),
    appointment("33", { ends_at: "2026-09-30T10:00:00Z" }),
  ]) {
    const provider = fakeProvider([[appointment("32"), row]]);
    const reader = readerFor(host, provider.port);
    failure(await reader.list(scope, "host-proof", from, to, now), "malformed");
  }
  const incomplete = fakeProvider([[appointment("33")], []], { total: 2 });
  failure(await readerFor(host, incomplete.port).list(scope, "host-proof", from, to, now), "unavailable");
  const excessive = fakeProvider([], { total: 501 });
  failure(await readerFor(host, excessive.port).list(scope, "host-proof", from, to, now), "tooManyResults");
});

test("cancelled rows are omitted; permission and transport faults stay typed", async () => {
  const provider = fakeProvider([[appointment("33", { cancelled_at: "2026-09-28T11:00:00Z" }), appointment("34")]]);
  const reader = readerFor(host, provider.port);
  assert.deepEqual(value(await reader.list(scope, "host-proof", from, to, now)).appointments.map(item => item.appointmentRef), ["34"]);
  for (const [status, expected] of [[401, "forbidden"], [403, "forbidden"], [429, "rateLimited"], [503, "unavailable"]] as const) {
    const faulty = fakeProvider([], { status });
    failure(await readerFor(host, faulty.port).list(scope, "host-proof", from, to, now), expected);
  }
});
