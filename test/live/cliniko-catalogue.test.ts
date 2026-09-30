import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";

type Page = Readonly<{ total_entries: number; items: readonly Readonly<{ id: string }>[] }>;

/** One bounded metadata page to select a demo-only fixture; no response records are retained. */
async function discover(base: string, path: "practitioners" | "appointment_types", headers: HeadersInit): Promise<Page> {
  const response = await fetch(`${base}/${path}?page=1&per_page=100`, { method: "GET", headers,
    redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `demo ${path} metadata GET failed`);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      assert.ok(bytes <= 1_000_000, `demo ${path} metadata exceeded bound`);
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const body: unknown = JSON.parse(raw);
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.ok(Number.isSafeInteger(record.total_entries) && Number(record.total_entries) >= 0);
  const items = record[path];
  assert.ok(Array.isArray(items) && items.length <= 100 && items.length > 0);
  const ids = items.map((item: unknown) => {
    assert.ok(item && typeof item === "object" && !Array.isArray(item));
    const id = (item as Record<string, unknown>).id;
    assert.match(String(id), /^[1-9][0-9]*$/);
    return { id: String(id) };
  });
  return { total_entries: Number(record.total_entries), items: ids };
}

test("C-LIVE-23 bounded demo catalogue returns a scoped read-only selection status",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" || !process.env.ABBY_CLINIKO_API_KEY ||
    !process.env.ABBY_CLINIKO_CONTACT_EMAIL, timeout: 90_000 }, async () => {
    const apiKey = process.env.ABBY_CLINIKO_API_KEY!;
    const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
    const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    assert.ok(shard);
    const base = `https://api.${shard}.cliniko.com/v1`;
    const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "User-Agent": `Abby (${contactEmail})` };
    const scope = { tenantId: "catalogue-demo", clinicId: "demo", locationId: "frontdesk" };
    const paths: string[] = [];
    const reader = ClinikoCatalogueReader.create({ scope, apiKey, contactEmail }, async (input, init) => {
      assert.equal(init?.method, "GET");
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(base).origin);
      assert.ok(/^\/v1\/(?:businesses|practitioners|appointment_types)(?:\/|$)/.test(url.pathname));
      paths.push(url.pathname);
      return fetch(input, init);
    });
    assert.ok(reader.ok);
    const catalogue = await reader.value.businesses(scope);
    assert.ok(catalogue.ok, catalogue.ok ? "" : catalogue.error.kind);
    assert.equal(catalogue.value.status, "complete");
    assert.deepEqual(catalogue.value.scope, scope);
    assert.ok(catalogue.value.businesses.length > 0);
    assert.equal(catalogue.value.credentialFingerprint, reader.value.credentialFingerprint());
    const business = catalogue.value.businesses[0]!;
    const [practitioners, types] = await Promise.all([
      discover(base, "practitioners", headers), discover(base, "appointment_types", headers),
    ]);
    assert.ok(practitioners.total_entries > 0 && types.total_entries > 0);
    const selection = { businessId: business.businessId, practitionerId: practitioners.items[0]!.id,
      appointmentTypeId: types.items[0]!.id, policyVersion: "demo-readonly-v1" };
    const inspected = await reader.value.inspect(scope, selection);
    assert.ok(inspected.ok, inspected.ok ? "" : inspected.error.kind);
    assert.deepEqual(inspected.value.scope, scope);
    assert.deepEqual(inspected.value.selection, selection);
    assert.equal(inspected.value.credentialFingerprint, reader.value.credentialFingerprint());
    assert.equal(inspected.value.patientActionMode, "unavailable");
    assert.equal(inspected.value.patientRequestMode, "unavailable");
    assert.equal(inspected.value.status === "candidate", inspected.value.reasons.length === 0);
    if (!business.onlineBooking) assert.ok(inspected.value.reasons.includes("businessOnlineBookingDisabled"));
    if (inspected.value.status === "candidate") assert.ok(inspected.value.timeZone);
    const beforeForeignScope = paths.length;
    assert.deepEqual(await reader.value.inspect({ ...scope, tenantId: "other" }, selection),
      { ok: false, error: { kind: "scopeMismatch" } });
    assert.equal(paths.length, beforeForeignScope);
    assert.ok(paths.every(path => !path.includes("patients") && !path.includes("appointments")));
    process.stdout.write(`Cliniko demo catalogue: ${catalogue.value.businesses.length} businesses; ` +
      `selection ${inspected.value.status}; reasons ${inspected.value.reasons.join(",") || "none"}; ` +
      `${paths.length + 2} bounded metadata GETs; no writes or patient reads\n`);
  });
