import assert from "node:assert/strict";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientProofHost } from "../../src/core/host.ts";
import { ok, err } from "../../src/core/model.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

const scope = { tenantId: "synthetic-class-tenant", clinicId: "synthetic-class-clinic", locationId: "synthetic-class-location" };
const now = "2026-10-07T10:00:00.000Z", to = "2026-10-14T10:00:00.000Z", base = "https://api.au5.cliniko.com/v1";
const link = (resource: string, id: string) => ({ links: { self: `${base}/${resource}/${id}` } });
function group(id: string, capacity = 3) {
  return { id, ...link("group_appointments", id), starts_at: "2026-10-08T10:00:00.000Z", ends_at: "2026-10-08T11:00:00.000Z",
    archived_at: null, deleted_at: null, max_attendees: capacity, patient_ids: ["untrusted-do-not-count"], notes: "private-class-shared-note",
    business: link("businesses", "11"), practitioner: link("practitioners", "22"), appointment_type: link("appointment_types", "33"),
    repeat_rule: { repeat_type: "Weekly", number_of_repeats: 4, repeating_interval: 1 } };
}
function attendee(id: string, booking: string, patient = "44", cancelled_at: string | null = null) {
  return { id, ...link("attendees", id), booking: link("bookings", booking), patient: link("patients", patient),
    archived_at: null, deleted_at: null, cancelled_at, notes: "private-attendee-note", patient_name: "private-other-name" };
}
export function classAttendanceFixture(options: { scope?: LocationScope; now?: string; patientId?: string; rateBudget?: ClinikoRequestBudget } = {}) {
  const boundScope = options.scope ?? scope, observedNow = options.now ?? now;
  const groups: Record<string, unknown>[] = [group("91"), group("92", 1), group("93"), group("94")];
  const attendees: Record<string, unknown>[] = [attendee("101", "91", "42"), attendee("102", "91"), attendee("103", "91", "45", now),
    attendee("104", "92"), attendee("105", "93", "42"), attendee("106", "93", "42")];
  const business: Record<string, unknown> = { id: "11", time_zone_identifier: "Australia/Sydney", archived_at: null, appointment_type_ids: ["33"] };
  const type: Record<string, unknown> = { id: "33", archived_at: null, max_attendees: 10 };
  const traffic: { path: string; filters: string[]; page: number }[] = [];
  let denied = false, subject = "42", proofCalls = 0, responseStatus = 200, missingRelationship = false;
  let onRead: ((path: string, count: number) => void) | undefined;
  let onResponse: ((path: string, body: Record<string, unknown>) => void) | undefined;
  const counts = new Map<string, number>();
  if (options.patientId) for (const row of attendees) {
    if ((row.patient as { links: { self: string } }).links.self === `${base}/patients/42`) row.patient = link("patients", options.patientId);
  }
  subject = options.patientId ?? subject;
  const proof: PatientProofHost = { verifyPatient: async (s, ref) => {
    proofCalls++; assert.deepEqual(s, boundScope); assert.equal(ref, "private-class-proof");
    return denied ? err({ kind: "expired", target: "patient" }) : ok({ scope: boundScope, patientRef: subject, verificationRef: ref, expiresAt: "2026-10-08T10:00:00.000Z" });
  } };
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), path = url.pathname; assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("User-Agent"), `Abby (${config.contactEmail})`);
    traffic.push({ path, filters: url.searchParams.getAll("q[]"), page: Number(url.searchParams.get("page") ?? 1) });
    const count = (counts.get(path) ?? 0) + 1; counts.set(path, count); onRead?.(path, count);
    if (responseStatus !== 200) return new Response(null, { status: responseStatus, headers: { "X-RateLimit-Reset": String(Date.parse(now) / 1000 + 60) } });
    if (path === "/v1/businesses/11") return Response.json(business);
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true });
    if (path === "/v1/appointment_types/33") return Response.json(type);
    let rows: Record<string, unknown>[] = [], name: string;
    if (path === "/v1/practitioners/22/businesses") { name = "businesses"; rows = missingRelationship ? [] : [{ id: "11", ...link(name, "11") }]; }
    else if (path === "/v1/practitioners/22/appointment_types") { name = "appointment_types"; rows = [{ id: "33", ...link(name, "33") }]; }
    else if (path === "/v1/group_appointments") { name = "group_appointments"; rows = groups; }
    else if (/^\/v1\/group_appointments\/\d+$/.test(path)) return Response.json(groups.find(row => row.id === path.split("/").at(-1)));
    else if (path === "/v1/attendees") {
      name = "attendees"; const booking = url.searchParams.getAll("q[]").find(filter => filter.startsWith("booking_id:="))!.slice(12);
      rows = attendees.filter(row => (row.booking as { links: { self: string } }).links.self === `${base}/bookings/${booking}`);
      assert.equal(url.searchParams.getAll("q[]").some(filter => filter.startsWith("patient_id")), false, "capacity counts the complete class, not only the caller");
    } else throw new Error(`unexpected native request ${path}`);
    const page = Number(url.searchParams.get("page"));
    const body = { [name]: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length };
    onResponse?.(path, body); return Response.json(body);
  };
  const budget = options.rateBudget ?? new ClinikoReadBudget(200, () => Date.parse(observedNow));
  const config = { scope: boundScope, apiKey: "synthetic-class-au5", contactEmail: "dev@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", className: "Approved mat Pilates", rateBudget: budget };
  const reader = resultValue(ClinikoClassAttendanceReader.create(config, proof, fetchPort, () => observedNow));
  return { reader, config, proof, fetchPort, groups, attendees, business, type, traffic, budget,
    list: (signal = new AbortController().signal) => reader.list(boundScope, "private-class-proof", observedNow, to, observedNow, signal),
    get proofCalls() { return proofCalls; }, revoke: () => { denied = true; }, changeSubject: () => { subject = "43"; },
    status: (status: number) => { responseStatus = status; }, noRelationship: () => { missingRelationship = true; },
    onRead: (callback: typeof onRead) => { onRead = callback; },
    onResponse: (callback: typeof onResponse) => { onResponse = callback; } };
}

export { scope as classScope, now as classNow, to as classUntil, base as classBase, link as classLink, group as classGroup, attendee as classAttendee };
