import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";

test("C-LIVE-23 E2E-227 bounded demo catalogue maps a scoped read-only selection through all list adapters",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" || !process.env.ABBY_CLINIKO_API_KEY ||
    !process.env.ABBY_CLINIKO_CONTACT_EMAIL, timeout: 90_000 }, async () => {
    const apiKey = process.env.ABBY_CLINIKO_API_KEY!;
    const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
    const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    assert.ok(shard);
    const base = `https://api.${shard}.cliniko.com/v1`;
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
    const practitioners = await reader.value.practitioners(scope, business.businessId);
    assert.ok(practitioners.ok, practitioners.ok ? "" : practitioners.error.kind);
    assert.deepEqual(practitioners.value.scope, scope);
    assert.equal(practitioners.value.businessId, business.businessId);
    assert.equal(practitioners.value.credentialFingerprint, reader.value.credentialFingerprint());
    assert.ok(practitioners.value.practitioners.length > 0);
    const practitioner = practitioners.value.practitioners[0]!;
    const types = await reader.value.appointmentTypes(scope, business.businessId, practitioner.practitionerId);
    assert.ok(types.ok, types.ok ? "" : types.error.kind);
    assert.deepEqual(types.value.scope, scope);
    assert.equal(types.value.businessId, business.businessId);
    assert.equal(types.value.practitionerId, practitioner.practitionerId);
    assert.equal(types.value.credentialFingerprint, reader.value.credentialFingerprint());
    assert.ok(types.value.appointmentTypes.length > 0);
    const selection = { businessId: business.businessId, practitionerId: practitioner.practitionerId,
      appointmentTypeId: types.value.appointmentTypes[0]!.appointmentTypeId, policyVersion: "demo-readonly-v1" };
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
    process.stdout.write(`Cliniko demo catalogue: ${catalogue.value.businesses.length} businesses, ` +
      `${practitioners.value.practitioners.length} practitioners, ${types.value.appointmentTypes.length} types; ` +
      `selection ${inspected.value.status}; reasons ${inspected.value.reasons.join(",") || "none"}; ` +
      `${paths.length} bounded metadata GETs; no writes or patient reads\n`);
  });
