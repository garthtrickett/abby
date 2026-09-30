import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

const scope = { tenantId: "catalogue-tenant", clinicId: "clinic", locationId: "frontdesk" };
const selection = { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "v1" };
const now = "2026-09-30T10:00:00.000Z";

function fixture(overrides: Partial<Record<string, unknown>> = {}) {
  const seen: string[] = [];
  const business = { id: "11", business_name: "Synthetic Clinic", archived_at: null,
    show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"],
    private_patient_name: "must-not-appear" };
  const practitioner = { id: "22", display_name: "Synthetic Practitioner", active: true,
    show_in_online_bookings: true, private_patient_note: "must-not-appear" };
  const appointmentType = { id: "33", name: "Initial consult", archived_at: null,
    show_in_online_bookings: true };
  const bodies: Record<string, unknown> = {
    "/v1/businesses": { total_entries: 1, businesses: [business] },
    "/v1/businesses/11": business,
    "/v1/practitioners/22": practitioner,
    "/v1/appointment_types/33": appointmentType,
    "/v1/businesses/11/practitioners": { total_entries: 1, practitioners: [practitioner] },
    "/v1/practitioners/22/appointment_types": { total_entries: 1, appointment_types: [appointmentType] },
    ...overrides,
  };
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}${url.search}`);
    assert.equal(url.hostname, "api.au5.cliniko.com");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (test@example.com)");
    const body = bodies[url.pathname];
    if (body instanceof Response) return body;
    if (body === undefined) throw new Error(`unexpected path ${url.pathname}`);
    return Response.json(body);
  };
  const created = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", rateBudget: new ClinikoReadBudget() }, fetchPort, () => now);
  assert.ok(created.ok);
  return { reader: created.value, seen };
}

test("B1 selected Cliniko catalogue produces only a scoped, unapproved candidate snapshot", async () => {
  const app = fixture();
  const businesses = await app.reader.businesses(scope);
  assert.deepEqual(businesses, { ok: true, value: { scope, observedAt: now,
    credentialFingerprint: app.reader.credentialFingerprint(), status: "complete",
    businesses: [{ businessId: "11", name: "Synthetic Clinic",
      timeZone: "Australia/Sydney", onlineBooking: true, archived: false }] } });
  const inspected = await app.reader.inspect(scope, selection);
  assert.ok(inspected.ok);
  assert.deepEqual(inspected.value, { scope, selection, observedAt: now,
    credentialFingerprint: app.reader.credentialFingerprint(), businessName: "Synthetic Clinic",
    practitionerName: "Synthetic Practitioner", appointmentTypeName: "Initial consult",
    timeZone: "Australia/Sydney", status: "candidate", reasons: [],
    patientActionMode: "unavailable", patientRequestMode: "unavailable" });
  assert.equal(app.seen.length, 6);
  assert.equal(JSON.stringify(inspected).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(inspected).includes("synthetic-key"), false);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope, selection, 60_000, now), true);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope, selection, 60_000,
    "2026-09-30T10:01:01.000Z"), false);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope,
    { ...selection, policyVersion: "v2" }, 60_000, now), false);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope, selection, 600_000, now), false);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value,
    { ...scope, tenantId: "other" }, selection, 60_000, now), false);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope,
    null as unknown as typeof selection, 60_000, now), false);
});

test("B1 wrong scope and invalid selection refuse before provider HTTP", async () => {
  const app = fixture();
  assert.deepEqual(await app.reader.businesses({ ...scope, tenantId: "other" }),
    { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(await app.reader.inspect({ ...scope, clinicId: "other" }, selection),
    { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(await app.reader.inspect(scope, { ...selection, businessId: "../11" }),
    { ok: false, error: { kind: "invalidSelection" } });
  assert.deepEqual(await app.reader.inspect(scope, null as unknown as typeof selection),
    { ok: false, error: { kind: "invalidSelection" } });
  assert.deepEqual(app.seen, []);
  assert.deepEqual(ClinikoCatalogueReader.create({ scope, apiKey: undefined,
    contactEmail: "test@example.com" } as unknown as Parameters<typeof ClinikoCatalogueReader.create>[0]),
  { ok: false, error: { kind: "invalidConfig" } });
});

test("B1 inactive, archived, unlisted and nullable flags never become approved availability", async () => {
  const app = fixture({
    "/v1/businesses/11": { id: "11", business_name: "Synthetic Clinic", archived_at: now,
      show_in_online_bookings: null, time_zone_identifier: "Mars/Olympus", appointment_type_ids: null },
    "/v1/practitioners/22": { id: "22", display_name: "Synthetic Practitioner", active: false,
      show_in_online_bookings: null },
    "/v1/appointment_types/33": { id: "33", name: "Initial consult", archived_at: now,
      show_in_online_bookings: null },
    "/v1/businesses/11/practitioners": { total_entries: 0, practitioners: [] },
    "/v1/practitioners/22/appointment_types": { total_entries: 0, appointment_types: [] },
  });
  const inspected = await app.reader.inspect(scope, selection);
  assert.ok(inspected.ok);
  assert.equal(inspected.value.status, "unavailable");
  assert.equal(inspected.value.timeZone, null);
  assert.deepEqual(inspected.value.reasons, ["businessArchived", "businessOnlineBookingDisabled",
    "businessTimeZoneUnknown", "businessTypeUnconfirmed", "practitionerInactive",
    "practitionerOnlineBookingDisabled", "practitionerNotAtBusiness", "appointmentTypeArchived",
    "appointmentTypeOnlineBookingDisabled", "appointmentTypeNotForPractitioner"]);
  assert.equal(inspected.value.patientActionMode, "unavailable");
  assert.equal(inspected.value.patientRequestMode, "unavailable");
});

test("B1 business type selection and relationship membership are separate gates", async () => {
  const app = fixture({
    "/v1/businesses/11": { id: "11", business_name: "Synthetic Clinic", archived_at: null,
      show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["44"] },
    "/v1/businesses/11/practitioners": { total_entries: 1, practitioners: [{ id: "55" }] },
    "/v1/practitioners/22/appointment_types": { total_entries: 1, appointment_types: [{ id: "66" }] },
  });
  const inspected = await app.reader.inspect(scope, selection);
  assert.ok(inspected.ok);
  assert.deepEqual(inspected.value.reasons, ["businessTypeNotSelected", "practitionerNotAtBusiness",
    "appointmentTypeNotForPractitioner"]);
});

test("B1 selected metadata with no display names is ineligible for clinic confirmation", async () => {
  const app = fixture({
    "/v1/businesses/11": { id: "11", business_name: " ", archived_at: null,
      show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] },
    "/v1/practitioners/22": { id: "22", display_name: null, active: true,
      show_in_online_bookings: true },
    "/v1/appointment_types/33": { id: "33", name: "", archived_at: null,
      show_in_online_bookings: true },
  });
  const inspected = await app.reader.inspect(scope, selection);
  assert.ok(inspected.ok);
  assert.equal(inspected.value.status, "unavailable");
  assert.deepEqual(inspected.value.reasons, ["businessNameUnknown", "practitionerNameUnknown",
    "appointmentTypeNameUnknown"]);
  assert.equal(app.reader.matchesCurrentSelection(inspected.value, scope, selection, 60_000, now), false);
});

test("B1 credential denial and partial pages do not publish a catalogue", async () => {
  const denied = fixture({ "/v1/businesses": new Response(null, { status: 403 }) });
  assert.deepEqual(await denied.reader.businesses(scope), { ok: false, error: { kind: "forbidden" } });
  const empty = fixture({ "/v1/businesses": { total_entries: 0, businesses: [] } });
  const emptyCatalogue = await empty.reader.businesses(scope);
  assert.ok(emptyCatalogue.ok);
  assert.deepEqual(emptyCatalogue.value.businesses, []);
  assert.equal(emptyCatalogue.value.status, "complete");
  const partial = fixture({ "/v1/businesses": { total_entries: 2, businesses: [{ id: "11",
    business_name: "Synthetic Clinic", show_in_online_bookings: true }] } });
  const partialResult = await partial.reader.businesses(scope);
  assert.deepEqual(partialResult, { ok: false, error: { kind: "malformed" } });
  assert.ok(partial.seen.some(path => path.includes("page=2")));
  const oversized = fixture({ "/v1/businesses": { total_entries: 1001, businesses: [] } });
  assert.deepEqual(await oversized.reader.businesses(scope), { ok: false, error: { kind: "tooManyResults" } });
});

test("B1 provider 429 is typed and credential rotation changes the snapshot fingerprint", async () => {
  const limited = fixture({ "/v1/businesses/11": new Response(null, { status: 429 }) });
  const throttled = await limited.reader.inspect(scope, selection);
  assert.equal(throttled.ok, false);
  if (!throttled.ok) assert.equal(throttled.error.kind, "rateLimited");
  assert.equal(limited.seen.length, 1);
  const first = fixture().reader.credentialFingerprint();
  const rotated = ClinikoCatalogueReader.create({ scope, apiKey: "other-key-au5", contactEmail: "test@example.com" });
  assert.ok(rotated.ok);
  assert.notEqual(rotated.value.credentialFingerprint(), first);
  assert.equal(first.includes("synthetic-key"), false);
  const inspected = await fixture().reader.inspect(scope, selection);
  assert.ok(inspected.ok);
  assert.equal(rotated.value.matchesCurrentSelection(inspected.value, scope, selection, 60_000, now), false);
});

test("B1 budget denial prevents HTTP and oversized responses never publish metadata", async () => {
  let sends = 0;
  const blocked = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com",
    rateBudget: { claim: () => ({ kind: "unavailable" }), observe429: () => ({ kind: "rateLimited" }) } },
  async () => { sends += 1; throw new Error("budget must block HTTP"); });
  assert.ok(blocked.ok);
  assert.deepEqual(await blocked.value.businesses(scope), { ok: false, error: { kind: "unavailable" } });
  assert.equal(sends, 0);
  const oversized = fixture({ "/v1/businesses": new Response("x".repeat(1_000_001)) });
  assert.deepEqual(await oversized.reader.businesses(scope), { ok: false, error: { kind: "tooManyResults" } });
});
