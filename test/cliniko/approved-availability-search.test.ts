import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoApprovedAvailabilitySearch } from "../../src/cliniko/approved-availability-search.ts";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { availabilityPresentation } from "../../src/core/availability-presentation.ts";

const scope = { tenantId: "test-tenant", clinicId: "clinic", locationId: "frontdesk" };
const date = "2026-10-01";
const now = "2026-09-30T23:00:00.000Z";

function fixture(mode: "times" | "rateLimit" | "badName" | "none" = "times") {
  const paths: string[] = [];
  const fetchPort: typeof fetch = async input => {
    const url = new URL(String(input));
    const path = url.pathname;
    paths.push(path);
    if (path === "/v1/businesses/11") return Response.json({ id: "11",
      show_in_online_bookings: true, appointment_type_ids: ["33", "55"],
      time_zone_identifier: "Australia/Sydney" });
    if (path === "/v1/practitioners/22" || path === "/v1/practitioners/44") {
      const alternative = path.endsWith("/44");
      return Response.json({ id: alternative ? "44" : "22", active: true,
        show_in_online_bookings: true,
        display_name: alternative && mode === "badName" ? "Bad\nname" :
          alternative ? "Dr Second" : "Dr First" });
    }
    if (path === "/v1/appointment_types/33" || path === "/v1/appointment_types/55") {
      const alternative = path.endsWith("/55");
      return Response.json({ id: alternative ? "55" : "33", show_in_online_bookings: true,
        name: alternative ? "Follow up" : "Consult" });
    }
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 2,
      practitioners: [{ id: "22" }, { id: "44" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    if (path === "/v1/practitioners/44/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "55" }] });
    if (path.endsWith("/available_times")) {
      if (path.includes("/practitioners/44/") && mode === "rateLimit") return new Response(null, { status: 429 });
      const starts = path.includes("/practitioners/44/") && mode !== "none"
        ? [{ appointment_start: "2026-10-01T11:00:00+10:00" }] : [];
      return Response.json({ total_entries: starts.length, available_times: starts });
    }
    throw new Error("unexpected provider path");
  };
  const create = (practitionerId: string, appointmentTypeId: string) => {
    const result = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.test", businessId: "11", practitionerId, appointmentTypeId },
    fetchPort, () => now);
    assert.ok(result.ok);
    return result.value;
  };
  return { paths, primary: create("22", "33"), alternative: create("44", "55") };
}

test("B4 an approved alternative is searched after an empty primary and named before a provisional time", async () => {
  const app = fixture();
  const search = new ClinikoApprovedAvailabilitySearch([app.primary, app.alternative], () => now);
  const result = await search.list(scope, date, date);
  assert.ok(result.ok && result.value.kind === "times");
  assert.deepEqual(result.value.offering, { practitionerName: "Dr Second", appointmentTypeName: "Follow up" });
  const presented = availabilityPresentation(result.value, scope, date, date, now, false);
  assert.ok(presented.ok);
  assert.match(presented.value.text, /For Follow up with Dr Second, the clinic's schedule currently shows possible times/);
  assert.match(presented.value.text, /These may change. I can't reserve or confirm/);
  assert.deepEqual(app.paths.filter(path => path.endsWith("/available_times")).map(path =>
    path.includes("/practitioners/44/") ? "alternative" : "primary"), ["primary", "alternative"]);
});

test("B4 no approved fallback reader means no other practitioner or type is queried", async () => {
  const app = fixture();
  const search = new ClinikoApprovedAvailabilitySearch([app.primary], () => now);
  const result = await search.list(scope, date, date);
  assert.ok(result.ok && result.value.kind === "times");
  const presented = availabilityPresentation(result.value, scope, date, date, now, false);
  assert.ok(presented.ok);
  assert.equal(presented.value.status, "empty");
  assert.equal(app.paths.some(path => path.includes("/44") || path.includes("/55")), false);
});

test("B4 an incomplete or unsafe alternative read cannot become a no-times or mislabeled answer", async () => {
  for (const mode of ["rateLimit", "badName"] as const) {
    const app = fixture(mode);
    const search = new ClinikoApprovedAvailabilitySearch([app.primary, app.alternative], () => now);
    const result = await search.list(scope, date, date);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, mode === "rateLimit" ? "rateLimited" : "malformed");
  }
});
