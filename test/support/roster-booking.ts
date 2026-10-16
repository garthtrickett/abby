import assert from "node:assert/strict";
import { bookingOffersFixture } from "./booking-offers.ts";
import type { RosterSearchPlan } from "../../src/cliniko/roster-calendar.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

type Row = Record<string, unknown>;
const base = "https://api.au5.cliniko.com/v1";
export const rosterPlan: RosterSearchPlan = { mode: "roster", maxSearchDays: 30, slotIntervalMinutes: 15,
  weekdayOrigin: "sunday", busyScope: "practitionerAllBusinesses" };
export function rosterInterval(name: string, id: string, start: string, end: string, businessId = "11", practitionerId = "22"): Row {
  return { id, links: { self: `${base}/${name}/${id}` }, business: { links: { self: `${base}/businesses/${businessId}` } },
    practitioner: { links: { self: `${base}/practitioners/${practitionerId}` } }, starts_at: start, ends_at: end, repeat_rule: null,
    archived_at: null, deleted_at: null, cancelled_at: null, notes: "private-calendar-canary", patient: { links: { self: `${base}/patients/9999` } } };
}
export function syntheticRosterProvider(selection: { businessId: string; practitionerId: string } = { businessId: "11", practitionerId: "22" }) {
  const { businessId, practitionerId } = selection, otherBusiness = businessId === "11" ? "12" : "11";
  const interval = (name: string, id: string, start: string, end: string, business = businessId) => rosterInterval(name, id, start, end, business, practitionerId);
  const rows: Record<string, Row[]> = {
    daily_availabilities: [{ id: "101", links: { self: `${base}/daily_availabilities/101` }, business: { links: { self: `${base}/businesses/${businessId}` } },
      practitioner: { links: { self: `${base}/practitioners/${practitionerId}` } }, day_of_week: 4, time_zone_identifier: "Australia/Sydney",
      availabilities: [{ starts_at: "09:00", ends_at: "12:00" }] }],
    availability_blocks: [interval("availability_blocks", "102", "2026-10-08T02:00:00.000Z", "2026-10-08T04:00:00.000Z")],
    individual_appointments: [interval("individual_appointments", "103", "2026-10-07T22:30:00.000Z", "2026-10-07T23:00:00.000Z", otherBusiness)],
    group_appointments: [interval("group_appointments", "104", "2026-10-07T23:30:00.000Z", "2026-10-08T00:00:00.000Z")],
    unavailable_blocks: [interval("unavailable_blocks", "105", "2026-10-08T00:30:00.000Z", "2026-10-08T01:00:00.000Z", otherBusiness)],
  };
  const requests: { collection: string; filters: string[]; page: number }[] = [];
  let hook: (name: string, count: number) => void | Promise<void> = () => {}, fault: string | undefined;
  const wrap = (port: typeof fetch): typeof fetch => async (input, init) => {
    const url = new URL(String(input)), name = url.pathname.split("/").at(-1)!;
    const filters = url.searchParams.getAll("q[]");
    if (rows[name] && filters.includes(`practitioner_id:=${practitionerId}`)) {
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      const page = Number(url.searchParams.get("page")); requests.push({ collection: name, filters, page });
      await hook(name, requests.filter(r => r.collection === name).length);
      if (fault === name) return new Response(null, { status: 503 });
      const lower = filters.find(f => f.startsWith("ends_at:>"))?.slice(9), upper = filters.find(f => f.startsWith("starts_at:<"))?.slice(11);
      const selected = rows[name]!.filter(row => (!lower || Date.parse(String(row.ends_at)) > Date.parse(lower)) &&
        (!upper || Date.parse(String(row.starts_at)) < Date.parse(upper)));
      const entries = selected.slice((page - 1) * 100, page * 100);
      return Response.json({ total_entries: selected.length, [name]: entries, links: { next: page * 100 < selected.length ? `${base}/${name}?page=${page + 1}` : null } });
    }
    const response = await port(input, init);
    if ([`/v1/businesses/${businessId}`, `/v1/practitioners/${practitionerId}`, ...["33", "34", "35", "36"].map(id => `/v1/appointment_types/${id}`)].includes(url.pathname)) {
      const row = await response.json(); return Response.json({ ...row, show_in_online_bookings: false }, { status: response.status });
    }
    return response;
  };
  return { rows, requests, wrap, fail: (name: string | undefined) => { fault = name; }, onRead: (run: typeof hook) => { hook = run; } };
}
export async function rosterBookingFixture(plan: typeof rosterPlan | null = rosterPlan, maxAdvanceDays = 30, budget?: ClinikoRequestBudget) {
  const calendar = syntheticRosterProvider();
  const f = await bookingOffersFixture({ fetchAround: calendar.wrap, maxAdvanceDays, ...(budget ? { budget } : {}), ...(plan ? { availabilityPlan: plan } : {}) });
  return { ...f, calendar, get posts() { return f.posts; }, get claims() { return f.claims; } };
}
