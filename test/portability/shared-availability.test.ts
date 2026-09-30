import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { Result } from "../../src/core/model.ts";
import { AvailabilityTextRunner } from "../../src/reference/availability-text-runner.ts";
import type { PreparedAvailabilityText } from "../../src/reference/availability-text-runner.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { StandaloneAvailabilityTextRunner } from "../../src/standalone/availability-text-runner.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const now = "2026-10-01T00:00:00Z";
const day = "2026-10-02";
const start = "2026-10-02T00:00:00.000Z";
const cases = ["shown", "empty", "rateLimited"] as const;
type Case = typeof cases[number];

function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

function readerFor(scope: { tenantId: string; clinicId: string; locationId: string }, scenario: Case,
                   appointmentId: string, methods: string[]): ClinikoAvailabilityReader {
  const fetchPort: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? "GET");
    assert.equal(init?.method, "GET");
    const path = new URL(String(input)).pathname;
    if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney" });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    if (path.endsWith("/available_times")) {
      if (scenario === "rateLimited") return new Response(null, { status: 429 });
      return Response.json({ total_entries: scenario === "shown" ? 1 : 0,
        available_times: scenario === "shown" ? [{ appointment_start: start, appointment_id: appointmentId }] : [] });
    }
    throw new Error(`unexpected Cliniko read: ${path}`);
  };
  return value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  fetchPort, () => now));
}

test("E2E-178 same availability cases run in strict Cliniko and embedded host compositions",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000, concurrency: 3 }, async t => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  await Promise.all(cases.map(scenario => t.test(scenario, async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const name = `abby_portability_${suffix}`;
    const target = new URL(adminUrl);
    target.pathname = `/${name}`;
    const admin = connectPostgres(adminUrl);
    let created = false;
    let db: ReturnType<typeof connectPostgres> | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin);
      created = true;
      db = connectPostgres(target.toString());
      await migrate(db);
      const observations: Array<{ status: string; message: string }> = [];
      for (const composition of ["standalone", "embedded"] as const) {
        const scope = { tenantId: `${composition}-${suffix}`, clinicId: "clinic", locationId: "main" };
        const methods: string[] = [];
        const appointmentId = `appointment-${composition}-${suffix}`;
        const callerText = `caller-${composition}-${suffix}`;
        const reader = readerFor(scope, scenario, appointmentId, methods);
        const host = new ReferenceClinicHost([], []);
        const ledger = new MemoryLedger();
        const runner: AvailabilityTextRunner = composition === "standalone"
          ? new StandaloneAvailabilityTextRunner(db, scope, reader, () => now)
          : new AvailabilityTextRunner(createEmbeddedTextComposition(ledger, new MemoryPolicyStore(), host, reader),
            scope, () => now);
        const prepared: PreparedAvailabilityText = value(await runner.prepare({ text: callerText, from: day, to: day }));
        assert.equal(prepared.status, scenario === "rateLimited" ? "failed" : scenario);
        assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
        assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
        assert.ok(methods.length >= 6 && methods.every(method => method === "GET"));
        assert.doesNotMatch(prepared.message, /confirmed appointment|staff (has|will) (receive|contact)/i);
        assert.equal(host.bookings(scope).length, 0);
        if (composition === "standalone") {
          assert.equal(host.tasks(scope).length, 0);
          assert.deepEqual(await scanPatientDataCanaries(db, [
            { label: "caller", value: callerText }, { label: "appointment", value: appointmentId },
            { label: "appointment_time", value: start },
          ]), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
            { label: "caller", value: callerText }, { label: "appointment", value: appointmentId },
          ]), []);
        } else {
          assert.ok((await ledger.read(prepared.callId, scope)).ok);
          assert.deepEqual(await db.selectFrom("calls").select("call_id")
            .where("tenant_id", "=", scope.tenantId as never).execute(), []);
        }
        observations.push({ status: prepared.status, message: prepared.message });
      }
      assert.deepEqual(observations.map(item => item.status), [
        scenario === "rateLimited" ? "failed" : scenario,
        scenario === "rateLimited" ? "failed" : scenario,
      ]);
      if (scenario === "shown") assert.ok(observations.every(item => /can't reserve or confirm/.test(item.message)));
      if (scenario === "rateLimited") assert.ok(observations.every(item => !/possible times/.test(item.message)));
    } finally {
      await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  })));
});
