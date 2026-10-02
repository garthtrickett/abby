import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import type { StaffedDestinationHost } from "../../src/core/staffed-destination.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
function value<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }
const host: StaffedDestinationHost = async (scope, ref) => ["host/desk-a", "host/desk-b"].includes(ref)
  ? ok({ scope: { ...scope }, destinationRef: ref, hostVersion: "host-route-v1", mode: "execute", ready: true })
  : err({ kind: "readinessFailed", missing: ["staffDestination"] });
function rich(routeHost: StaffedDestinationHost = host) {
  return new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, "unsafeReference", false, undefined, staffedDestinationRegistry(routeHost));
}

test("E2E-256 SET-007 PostgreSQL route settings and history survive reconstruction without persisting host permission", async () => {
  const scope = { tenantId: `native/tenant ${randomUUID()}`, clinicId: "native/clinic", locationId: "native/location" };
  const policy = rich();
  assert.equal(value(await policy.read(scope)).transferDestinationRef, undefined);
  const enabled = value(await policy.changeStaffedDestination(scope, "0", "host/desk-a", "owner"));
  assert.equal(enabled.capabilities.transfer, "execute");
  assert.equal(enabled.transferDestinationVersion, "host-route-v1");
  const captured = structuredClone(enabled);
  value(await policy.changeStaffedDestination(scope, "1", "host/desk-b", "owner"));
  assert.equal(value(await rich().read(scope)).transferDestinationRef, "host/desk-b");
  assert.equal(captured.transferDestinationRef, "host/desk-a");
  const unproven = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, "unsafeReference");
  assert.notEqual(value(await unproven.read(scope)).capabilities.transfer, "execute");
  assert.equal(value(await unproven.read(scope)).transferDestinationVersion, undefined);
  value(await policy.changeStaffedDestination(scope, "2", null, "owner"));
  assert.equal(value(await rich().read(scope)).transferDestinationRef, undefined);
  const rows = await sql<{ policy: Record<string, unknown>; previous: string | null; kind: string }>`
    select policy, previous_staffed_destination_ref as previous, setting_kind as kind from clinic_settings
    where tenant_id = ${scope.tenantId} order by version`.execute(db);
  assert.deepEqual(rows.rows.map(row => [row.kind, row.previous]),
    [["booking", null], ["staffedDestination", null], ["staffedDestination", "host/desk-a"], ["staffedDestination", "host/desk-b"]]);
  assert.ok(rows.rows.every(row => !Object.hasOwn(row.policy, "transferDestinationVersion")));
  assert.deepEqual(value(await rich().listStaffedDestinationChanges(scope)).entries
    .map(row => [row.version, row.destinationRef, row.previousDestinationRef]),
  [["1", "host/desk-a", null], ["2", "host/desk-b", "host/desk-a"], ["3", null, "host/desk-b"]]);
  assert.deepEqual(value(await rich().listStaffedDestinationChanges({ ...scope, locationId: "other" })), { entries: [] });
});

test("E2E-256 SET-007 standalone persists only public route configuration and keeps live transfer unavailable", async () => {
  const scope = { tenantId: `route-minimal-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const defaults = (bound: LocationScope) => ({ ...referenceDefaultPolicy(bound), transferDestinationRef: "forged-default-route",
    transferDestinationVersion: "forged-version", capabilities: { ...referenceDefaultPolicy(bound).capabilities, transfer: "execute" as const } });
  const make = () => new PostgresPolicyStore(db, defaults, "execute", undefined, true, "standaloneMinimal", false, undefined, staffedDestinationRegistry(host));
  const policy = make();
  assert.equal(value(await policy.read(scope)).capabilities.transfer, "unavailable");
  const first = value(await policy.changeStaffedDestination(scope, "0", "host/desk-a", "owner"));
  assert.equal(first.capabilities.transfer, "unavailable");
  assert.equal(first.transferDestinationVersion, undefined);
  const edit = async (action: (version: string) => Promise<Result<unknown, unknown>>) => {
    value(await action(value(await policy.read(scope)).policyVersion));
    const head = value(await make().read(scope));
    assert.equal(head.transferDestinationRef, "host/desk-a");
    assert.equal(head.capabilities.transfer, "unavailable");
  };
  await edit(version => policy.changeBookingEnabled(scope, version, false, "owner"));
  await edit(version => policy.changeCancellationEnabled(scope, version, false, "owner"));
  await edit(version => policy.changeReschedulingEnabled(scope, version, false, "owner"));
  await edit(version => policy.changeAfterHours(scope, version, "staffRequest", undefined, "owner"));
  await edit(version => policy.changeUrgentResponse(scope, version, undefined, "owner"));
  await edit(version => policy.changeStaffSchedule(scope, version, undefined, "owner"));
  await edit(version => policy.changeGreeting(scope, version, undefined, "owner"));
  const rows = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings
    where tenant_id = ${scope.tenantId} and version > 0`.execute(db);
  const fields = new Set(["scope", "policyVersion", "bookingEnabled", "cancellationEnabled", "reschedulingEnabled",
    "afterHoursMode", "greeting", "transferDestinationRef"]);
  assert.ok(rows.rows.every(row => Object.keys(row.policy).every(key => fields.has(key))));
  assert.ok(rows.rows.every(row => row.policy.transferDestinationRef === "host/desk-a"));
  assert.deepEqual(await policy.changeStaffedDestination(scope, "8", "+61400111222", "owner"),
    { ok: false, error: { kind: "readinessFailed", missing: ["staffDestination"] } });
  value(await policy.changeStaffedDestination(scope, "8", null, "owner"));
  assert.equal(value(await make().read(scope)).transferDestinationRef, undefined);
  assert.equal(value(await make().read(scope)).capabilities.transfer, "unavailable");
});

test("E2E-256 SET-007 PostgreSQL rechecks the shared location version after host validation and allows only one concurrent winner", async () => {
  const scope = { tenantId: `route-race-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  let release!: () => void;
  let announce!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const delayed = rich(async (bound, ref) => { announce(); await held; return host(bound, ref); });
  const pending = delayed.changeStaffedDestination(scope, "0", "host/desk-a", "route-owner");
  await entered;
  value(await rich().changeBookingEnabled(scope, "0", true, "booking-owner"));
  release();
  assert.deepEqual(await pending, { ok: false, error: { kind: "versionConflict" } });
  assert.equal(value(await rich().read(scope)).bookingEnabled, true);
  assert.deepEqual(value(await rich().listStaffedDestinationChanges(scope)), { entries: [] });
  const results = await Promise.all([
    rich().changeStaffedDestination(scope, "1", "host/desk-a", "owner-a"),
    rich().changeStaffedDestination(scope, "1", "host/desk-b", "owner-b"),
  ]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.deepEqual(results.filter(row => !row.ok), [{ ok: false, error: { kind: "versionConflict" } }]);
  assert.equal(value(await rich().listStaffedDestinationChanges(scope)).entries.length, 1);
  const wrong = rich(async (bound, ref) => ok({ scope: { ...bound, clinicId: "foreign" },
    destinationRef: ref, hostVersion: "host-route-v1", mode: "execute", ready: true }));
  assert.deepEqual(await wrong.changeStaffedDestination(scope, "2", "host/desk-b", "owner"),
    { ok: false, error: { kind: "readinessFailed", missing: ["staffDestination"] } });
  assert.equal(value(await rich().read(scope)).policyVersion, "2");
});

test("E2E-256 SET-007 route audit pages exclude unrelated changes and rollback refuses recorded history", async () => {
  const name = `staffed_route_${randomUUID().replaceAll("-", "")}`;
  let fresh: ReturnType<typeof connectPostgres> | undefined;
  let created = false;
  try {
    await sql.raw(`create database "${name}"`).execute(db);
    created = true;
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    fresh = connectPostgres(url.toString());
    await migrate(fresh);
    const policy = new PostgresPolicyStore(fresh, referenceDefaultPolicy, "execute", undefined, true, "unsafeReference", false, undefined, staffedDestinationRegistry(host));
    const scope = { tenantId: "route-audit", clinicId: "clinic", locationId: "main" };
    for (let index = 0; index < 51; index++) {
      const head = value(await policy.read(scope));
      value(await policy.changeStaffedDestination(scope, head.policyVersion, index % 2 ? null : "host/desk-a", "owner"));
      value(await policy.changeBookingEnabled(scope, String(Number(head.policyVersion) + 1), index % 2 === 0, "booking-owner"));
    }
    const page = value(await policy.listStaffedDestinationChanges(scope));
    assert.equal(page.entries.length, 50);
    assert.equal(page.nextAfterVersion, 99);
    assert.deepEqual(value(await policy.listStaffedDestinationChanges(scope, page.nextAfterVersion)).entries.map(row => row.version), ["101"]);
    assert.deepEqual(value(await policy.listStaffedDestinationChanges(scope, Number.MAX_SAFE_INTEGER)), { entries: [] });
    await assert.rejects(migrateTo(fresh, "037_clinic_intake_setting"), /staffed destination setting history must be removed/);
    assert.equal(value(await policy.read(scope)).transferDestinationRef, "host/desk-a");
    assert.equal(value(await policy.listStaffedDestinationChanges(scope)).entries.length, 50);
  } finally {
    await fresh?.destroy();
    if (created) await sql.raw(`drop database "${name}" with (force)`).execute(db);
  }
});
