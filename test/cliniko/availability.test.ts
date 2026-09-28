import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import type { ClinikoAvailabilityConfig } from "../../src/cliniko/availability.ts";
import type { Result } from "../../src/core/model.ts";

const scope = { tenantId: "cliniko-tenant", clinicId: "cliniko-clinic", locationId: "cliniko-location" };
const config: ClinikoAvailabilityConfig = {
  scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33",
};

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), { status, ...(headers ? { headers } : {}) });
}

type RequestRecord = { url: URL; method: string; headers: Headers; redirect: RequestRedirect };

function fakeProvider(options: {
  disabled?: "business" | "practitioner" | "appointmentType";
  status?: number;
  malformed?: boolean;
  starts?: readonly string[];
  changingTotal?: boolean;
  oversized?: boolean;
  invalidTimeZone?: boolean;
} = {}) {
  const requests: RequestRecord[] = [];
  const starts = options.starts ?? ["2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"];
  const port = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), redirect: init?.redirect ?? "follow" });
    if (options.status) return json({}, options.status, options.status === 429 ? { "X-RateLimit-Reset": "1893456000" } : undefined);
    if (options.oversized) return json({ padding: "x".repeat(1_000_001) });
    const path = url.pathname;
    if (path === "/v1/businesses/11") return json({ id: options.malformed ? "99" : "11", show_in_online_bookings: options.disabled !== "business",
      time_zone_identifier: options.invalidTimeZone ? "invalid/timezone" : "Australia/Sydney" });
    if (path === "/v1/practitioners/22") return json({ id: "22", show_in_online_bookings: options.disabled !== "practitioner" });
    if (path === "/v1/appointment_types/33") return json({ id: "33", show_in_online_bookings: options.disabled !== "appointmentType" });
    if (path.endsWith("/available_times")) {
      const page = Number(url.searchParams.get("page"));
      const slice = starts.slice((page - 1) * 100, page * 100).map(appointment_start => ({ appointment_start }));
      return json({ total_entries: options.changingTotal && page === 2 ? starts.length + 1 : starts.length, available_times: slice });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { port, requests };
}

test("Cliniko availability reads the bound shard and all pages without creating a reservable offer", async () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const starts = Array.from({ length: 101 }, (_, index) => new Date(start + index * 3_600_000).toISOString());
  const fake = fakeProvider({ starts });
  const reader = value(ClinikoAvailabilityReader.create(config, fake.port));
  const result = value(await reader.list(scope, "2026-10-01", "2026-10-07"));
  assert.equal(result.kind, "times");
  if (result.kind !== "times") return;
  assert.equal(result.reservable, false);
  assert.deepEqual(result.scope, scope);
  assert.deepEqual(result.startsAt, starts);
  assert.equal(result.businessRef, "11");
  assert.equal(result.timeZone, "Australia/Sydney");
  assert.equal(result.sourceRef, "cliniko:11:22:33");
  assert.equal(Number.isFinite(Date.parse(result.observedAt)), true);
  assert.equal(fake.requests.length, 5);
  assert.deepEqual(fake.requests.filter(request => request.url.pathname.endsWith("/available_times")).map(request => request.url.searchParams.get("page")), ["1", "2"]);
  for (const request of fake.requests) {
    assert.equal(request.url.origin, "https://api.au5.cliniko.com");
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("Authorization"), `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    assert.equal(request.headers.get("User-Agent"), "Abby (dev@example.test)");
  }
});

for (const disabled of ["business", "practitioner", "appointmentType"] as const) {
  test(`Cliniko ${disabled} online-booking flag blocks availability reads`, async () => {
    const fake = fakeProvider({ disabled });
    const reader = value(ClinikoAvailabilityReader.create(config, fake.port));
    assert.deepEqual(value(await reader.list(scope, "2026-10-01", "2026-10-02")), { kind: "notEligible", reason: disabled });
    assert.equal(fake.requests.some(request => request.url.pathname.endsWith("/available_times")), false);
  });
}

test("Cliniko scope, configuration, and date bounds fail before an HTTP request", async () => {
  const fake = fakeProvider();
  failure(ClinikoAvailabilityReader.create({ ...config, apiKey: "bad-key" }, fake.port), "invalidConfig");
  failure(ClinikoAvailabilityReader.create({ ...config, businessId: "../patients" }, fake.port), "invalidConfig");
  const reader = value(ClinikoAvailabilityReader.create(config, fake.port));
  failure(await reader.list({ ...scope, tenantId: "other-tenant" }, "2026-10-01", "2026-10-02"), "scopeMismatch");
  failure(await reader.list(scope, "2026-10-01", "2026-10-09"), "invalidRange");
  failure(await reader.list(scope, "2026-02-30", "2026-03-01"), "invalidRange");
  assert.equal(fake.requests.length, 0);
});

test("Cliniko provider faults stay typed and never become an empty availability claim", async () => {
  for (const [status, expected] of [[403, "forbidden"], [404, "notFound"], [429, "rateLimited"], [500, "unavailable"]] as const) {
    const fake = fakeProvider({ status });
    const reader = value(ClinikoAvailabilityReader.create(config, fake.port));
    const result = await reader.list(scope, "2026-10-01", "2026-10-02");
    failure(result, expected);
    if (!result.ok && result.error.kind === "rateLimited") assert.equal(result.error.resetAt, "2030-01-01T00:00:00.000Z");
  }
  const failedFetch = (async () => { throw new Error("network failure"); }) as typeof fetch;
  failure(await value(ClinikoAvailabilityReader.create(config, failedFetch)).list(scope, "2026-10-01", "2026-10-02"), "unavailable");
});

test("Cliniko malformed, oversized, and changing responses cannot produce an offer", async () => {
  for (const [options, expected] of [
    [{ malformed: true }, "malformed"],
    [{ invalidTimeZone: true }, "malformed"],
    [{ oversized: true }, "tooManyResults"],
    [{ starts: Array.from({ length: 101 }, (_, index) => new Date(Date.parse("2026-10-01T00:00:00Z") + index * 3_600_000).toISOString()), changingTotal: true }, "unavailable"],
  ] as const) {
    const fake = fakeProvider(options);
    const reader = value(ClinikoAvailabilityReader.create(config, fake.port));
    failure(await reader.list(scope, "2026-10-01", "2026-10-07"), expected);
  }
});
