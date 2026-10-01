import { serveClinikoAdmin } from "../../scripts/serve-cliniko-admin.ts";

if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" ||
    !process.env.DATABASE_URL?.includes("/abby_test_admin_")) {
  throw new Error("synthetic clinic admin requires an isolated fixture");
}

const clinikoFetch: typeof fetch = async (input, init) => {
  if (init?.method !== "GET") throw new Error("synthetic Cliniko write refused");
  const path = new URL(String(input)).pathname;
  process.send?.({ kind: "clinikoPath", path });
  if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
    business_name: "Synthetic clinic", show_in_online_bookings: true,
    time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] }] });
  if (path === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
    show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] });
  if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Synthetic practitioner",
    active: true, show_in_online_bookings: true });
  if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
    show_in_online_bookings: true });
  if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
    practitioners: [{ id: "22" }] });
  if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
    appointment_types: [{ id: "33" }] });
  throw new Error("unexpected synthetic catalogue request");
};

await serveClinikoAdmin({ clinikoFetch });
