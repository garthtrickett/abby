import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { captureStaffedDestination, listStaffedDestinations, resolveStaffedDestination } from "../../src/core/staffed-destination.ts";
import type { StaffedDestinationCatalogue, StaffedDestinationEvidence, StaffedDestinationHost } from "../../src/core/staffed-destination.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { matchesSchema } from "../../src/reference/schema-shapes.ts";

const scope = { tenantId: "native/tenant 1", clinicId: "native/clinic 2", locationId: "native/location 3" };
const now = "2026-10-02T10:00:00.000Z";
const unavailable = { ok: false, error: { kind: "readinessFailed", missing: ["staffDestination"] } };
function value<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }
function evidence(bound: LocationScope, destinationRef: string): StaffedDestinationEvidence {
  return { scope: { ...bound }, destinationRef, hostVersion: "host-route-v1", mode: "execute", ready: true };
}
const host: StaffedDestinationHost = async (bound, ref) => ref === "host/desk-a" || ref === "host/desk-b"
  ? ok(evidence(bound, ref)) : err({ kind: "readinessFailed", missing: ["staffDestination"] });

test("E2E-256 SET-007 host route evidence is bound to the exact location and selected reference", async () => {
  assert.deepEqual(value(await resolveStaffedDestination(host, scope, "host/desk-a")), evidence(scope, "host/desk-a"));
  assert.deepEqual(await resolveStaffedDestination(host, scope, "+61400111222"), unavailable);
  const correct = evidence(scope, "host/desk-a");
  const wrong: unknown[] = [
    { ...correct, scope: { ...scope, tenantId: "other" } },
    { ...correct, scope: { ...scope, clinicId: "other" } },
    { ...correct, scope: { ...scope, locationId: "other" } },
    { ...correct, destinationRef: "host/desk-b" },
    { ...correct, ready: false },
    { ...correct, hostVersion: "" },
    { ...correct, mode: "unavailable" },
    { ...correct, patientNotes: "patient-canary" },
    { ...correct, scope: { ...scope, patientId: "patient-canary" } },
    null,
  ];
  for (const malformed of wrong) {
    const adapter: StaffedDestinationHost = async () => ok(malformed as StaffedDestinationEvidence);
    assert.deepEqual(await resolveStaffedDestination(adapter, scope, "host/desk-a"), unavailable);
  }
  assert.deepEqual(await resolveStaffedDestination(async () => { throw new Error("provider details must not escape"); },
    scope, "host/desk-a"), unavailable);
});

test("E2E-256 SET-007 host boundary isolates caller and adapter objects and cannot grant transfer from a raw flag", async () => {
  const result = evidence(scope, "host/desk-a");
  const resolved = value(await resolveStaffedDestination(async bound => {
    (bound as { clinicId: string }).clinicId = "adapter-mutated";
    return ok(result);
  }, scope, "host/desk-a"));
  assert.equal(scope.clinicId, "native/clinic 2");
  (resolved as { hostVersion: string }).hostVersion = "caller-mutated";
  assert.equal(result.hostVersion, "host-route-v1");
  const forged = { ...referenceDefaultPolicy(scope), transferDestinationRef: "host/desk-a",
    transferDestinationVersion: "forged", capabilities: { ...referenceDefaultPolicy(scope).capabilities, transfer: "execute" as const } };
  const missing = await captureStaffedDestination(forged, async () =>
    err({ kind: "readinessFailed", missing: ["staffDestination"] }));
  assert.equal(missing.capabilities.transfer, "unavailable");
  assert.equal(missing.transferDestinationVersion, undefined);
  const supported = await captureStaffedDestination(forged, host);
  assert.equal(supported.capabilities.transfer, "execute");
  assert.equal(supported.transferDestinationVersion, "host-route-v1");
  const requestOnly = await captureStaffedDestination(forged, async bound => ok({ ...evidence(bound, "host/desk-a"), mode: "requestOnly" }));
  assert.equal(requestOnly.capabilities.transfer, "requestOnly");
  assert.equal(forged.transferDestinationVersion, "forged");
});

test("E2E-256 SET-007 route edits preserve admitted snapshots, change subsequent calls and record only public audit", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, undefined, staffedDestinationRegistry(host));
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const before = value(await reception.startCall("route-before", scope, now));
  assert.equal(before.policy.transferDestinationRef, undefined);
  const first = value(await policy.changeStaffedDestination(scope, "0", "host/desk-a", "clinic-owner"));
  assert.equal(first.policyVersion, "1");
  assert.equal(first.capabilities.transfer, "execute");
  assert.equal(first.transferDestinationVersion, "host-route-v1");
  const admitted = value(await reception.startCall("route-enabled", scope, now));
  value(await policy.changeStaffedDestination(scope, "1", "host/desk-b", "clinic-owner"));
  assert.equal(admitted.policy.transferDestinationRef, "host/desk-a");
  assert.equal(value(await reception.startCall("route-replaced", scope, now)).policy.transferDestinationRef, "host/desk-b");
  value(await policy.changeStaffedDestination(scope, "2", null, "clinic-owner"));
  const cleared = value(await reception.startCall("route-cleared", scope, now));
  assert.equal(cleared.policy.transferDestinationRef, undefined);
  assert.notEqual(cleared.policy.capabilities.transfer, "execute");
  assert.equal(admitted.policy.capabilities.transfer, "execute");
  assert.equal(value(await policy.read({ ...scope, locationId: "other" })).transferDestinationRef, undefined);
  const audit = value(await policy.listStaffedDestinationChanges(scope));
  assert.deepEqual(audit.entries.map(row => [row.version, row.destinationRef, row.previousDestinationRef]),
    [["1", "host/desk-a", null], ["2", "host/desk-b", "host/desk-a"], ["3", null, "host/desk-b"]]);
  assert.deepEqual(Object.keys(audit.entries[0]!).sort(), ["actorRef", "changedAt", "destinationRef", "previousDestinationRef", "version"]);
  assert.equal(value(await policy.listBookingChanges(scope)).entries.length, 0);
});

test("E2E-256 SET-007 delayed host validation cannot overwrite a concurrent location setting", async () => {
  let release!: () => void;
  let announce!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const delayed: StaffedDestinationHost = async (bound, ref) => {
    announce();
    await held;
    return ok(evidence(bound, ref));
  };
  const policy = new MemoryPolicyStore("execute", () => now, undefined, undefined, staffedDestinationRegistry(delayed));
  const pending = policy.changeStaffedDestination(scope, "0", "host/desk-a", "route-owner");
  await entered;
  value(await policy.changeBookingEnabled(scope, "0", true, "booking-owner"));
  release();
  assert.deepEqual(await pending, { ok: false, error: { kind: "versionConflict" } });
  assert.equal(value(await policy.read(scope)).bookingEnabled, true);
  assert.equal(value(await policy.read(scope)).transferDestinationRef, undefined);
  assert.deepEqual(value(await policy.listStaffedDestinationChanges(scope)), { entries: [] });
});

test("E2E-256 SET-007 failed or invalid route edits cannot leave a route or an audit record", async () => {
  let clock: "ok" | "throw" | "invalid" = "ok";
  const policy = new MemoryPolicyStore("execute", () => {
    if (clock === "throw") throw new Error("synthetic clock failed");
    return clock === "invalid" ? "not a timestamp" : now;
  }, undefined, undefined, staffedDestinationRegistry(host));
  assert.deepEqual(await policy.changeStaffedDestination(scope, "0", "+61400111222", "owner"), unavailable);
  for (const ref of ["", " ", "host\nroute", "x".repeat(257)]) {
    assert.deepEqual(await policy.changeStaffedDestination(scope, "0", ref, "owner"),
      { ok: false, error: { kind: "invalidValue" } });
  }
  for (const version of ["00", "-1", "1.5", String(Number.MAX_SAFE_INTEGER)]) {
    assert.deepEqual(await policy.changeStaffedDestination(scope, version, "host/desk-a", "owner"),
      { ok: false, error: { kind: "invalidValue" } });
  }
  for (const broken of ["throw", "invalid"] as const) {
    clock = broken;
    assert.deepEqual(await policy.changeStaffedDestination(scope, "0", "host/desk-a", "owner"),
      { ok: false, error: { kind: "storageFailure" } });
  }
  assert.equal(value(await policy.read(scope)).policyVersion, "0");
  assert.deepEqual(value(await policy.listStaffedDestinationChanges(scope)), { entries: [] });
  assert.deepEqual(await policy.changeStaffedDestination({ ...scope, clinicId: "" }, "0", null, "owner"),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await policy.listStaffedDestinationChanges({ ...scope, clinicId: "" }),
    { ok: false, error: { kind: "invalidValue" } });
});

test("E2E-256 SET-007 current host withdrawal affects new reads without changing an admitted call or replaying an edit", async () => {
  let ready = true;
  const changing: StaffedDestinationHost = async (bound, ref) => ready ? ok(evidence(bound, ref)) :
    err({ kind: "readinessFailed", missing: ["staffDestination"] });
  const policy = new MemoryPolicyStore("execute", () => now, undefined, undefined, staffedDestinationRegistry(changing));
  const admitted = value(await policy.changeStaffedDestination(scope, "0", "host/desk-a", "owner"));
  ready = false;
  const next = value(await policy.read(scope));
  assert.equal(next.transferDestinationRef, "host/desk-a");
  assert.notEqual(next.capabilities.transfer, "execute");
  assert.equal(next.transferDestinationVersion, undefined);
  assert.equal(next.policyVersion, "1");
  assert.equal(admitted.capabilities.transfer, "execute");
  assert.equal(admitted.transferDestinationVersion, "host-route-v1");
  assert.equal(value(await policy.listStaffedDestinationChanges(scope)).entries.length, 1);
  // Clearing must remain possible when the old host destination is unavailable.
  value(await policy.changeStaffedDestination(scope, "1", null, "owner"));
});

test("E2E-256 SET-007 route audit pages exclude unrelated edits, preserve clones and isolate locations", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, undefined, staffedDestinationRegistry(host));
  for (let index = 0; index < 51; index++) {
    const head = value(await policy.read(scope));
    value(await policy.changeStaffedDestination(scope, head.policyVersion, index % 2 ? null : "host/desk-a", "owner"));
    const current = value(await policy.read(scope));
    value(await policy.changeBookingEnabled(scope, current.policyVersion, index % 2 === 0, "booking-owner"));
  }
  const first = value(await policy.listStaffedDestinationChanges(scope));
  assert.equal(first.entries.length, 50);
  assert.equal(first.nextAfterVersion, 99);
  const second = value(await policy.listStaffedDestinationChanges(scope, first.nextAfterVersion));
  assert.deepEqual(second.entries.map(row => row.version), ["101"]);
  (first.entries[0] as { destinationRef: string | null }).destinationRef = "caller-mutated";
  assert.equal(value(await policy.listStaffedDestinationChanges(scope)).entries[0]!.destinationRef, "host/desk-a");
  assert.deepEqual(value(await policy.listStaffedDestinationChanges({ ...scope, locationId: "other" })), { entries: [] });
  for (const cursor of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await policy.listStaffedDestinationChanges(scope, cursor), { ok: false, error: { kind: "invalidValue" } });
  }
});

test("E2E-256 SET-007 gateway binds route edits to clinic-admin identity and rejects caller-supplied authority", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, undefined, staffedDestinationRegistry(host));
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const change = "settings.routing.staffedDestination.change.v1" as const;
  const audit = "settings.routing.staffedDestination.audit.v1" as const;
  const admin = new CommandGateway({ actorRef: "owner".repeat(40), role: "clinicAdmin", scope }, policy, reception);
  const descriptor = admin.listPermitted().find(row => row.id === change);
  assert.ok(descriptor);
  assert.deepEqual(descriptor.preconditions, ["expectedPolicyVersion", "hostStaffedDestinationForSet"]);
  for (const role of ["staff", "agent"] as const) {
    const denied = new CommandGateway({ actorRef: role, role, scope }, policy, reception);
    assert.equal(denied.listPermitted().some(row => row.id === change || row.id === audit || row.id === "settings.routing.staffedDestination.options.v1"), false);
    assert.deepEqual(await denied.submit({ kind: change, expectedVersion: "0", destinationRef: "host/desk-a" }),
      { ok: false, error: { kind: "forbidden" } });
    assert.deepEqual(await denied.submit({ kind: audit }), { ok: false, error: { kind: "forbidden" } });
    assert.deepEqual(await denied.submit({ kind: "settings.routing.staffedDestination.options.v1" }), { ok: false, error: { kind: "forbidden" } });
  }
  const options = value(await admin.submit({ kind: "settings.routing.staffedDestination.options.v1" }));
  assert.equal(options.kind, "staffedDestinationOptions");
  if (options.kind !== "staffedDestinationOptions") throw new Error("wrong options reply");
  assert.deepEqual(options.catalogue.scope, scope);
  assert.deepEqual(options.catalogue.options.map(row => row.label), ["Front desk", "Reception team"]);
  for (const malformed of [
    { kind: change, expectedVersion: "0", destinationRef: 123 },
    { kind: change, expectedVersion: "0" },
    { kind: change, expectedVersion: "0", destinationRef: "host/desk-a", actorRef: "forged" },
    { kind: change, expectedVersion: "0", destinationRef: "host/desk-a", scope: { ...scope, clinicId: "foreign" } },
    { kind: change, expectedVersion: "0", destinationRef: "host/desk-a", mode: "execute", ready: true },
  ]) {
    assert.deepEqual(await admin.submit(malformed as unknown as GatewayCommand), { ok: false, error: { kind: "invalid" } });
  }
  assert.deepEqual(await admin.submit({ kind: change, expectedVersion: "0", destinationRef: "+61400111222" }), unavailable);
  const command = { kind: change, expectedVersion: "0", destinationRef: "host/desk-a" };
  assert.ok(matchesSchema(descriptor.inputSchema, command));
  const changed = await admin.submit(command);
  assert.ok(changed.ok);
  assert.ok(matchesSchema(descriptor.resultSchema, changed));
  assert.equal(changed.value.kind, "settings");
  if (changed.value.kind !== "settings") throw new Error("wrong route reply");
  assert.equal(changed.value.policy.transferDestinationVersion, "host-route-v1");
  assert.deepEqual(await admin.submit({ kind: change, expectedVersion: "0", destinationRef: null }),
    { ok: false, error: { kind: "versionConflict" } });
  const history = value(await admin.submit({ kind: audit }));
  assert.equal(history.kind, "staffedDestinationSettingAudit");
  if (history.kind !== "staffedDestinationSettingAudit") throw new Error("wrong audit reply");
  assert.equal(history.page.entries[0]!.actorRef, "owner".repeat(40));
  value(await admin.submit({ kind: change, expectedVersion: "1", destinationRef: null }));
  assert.equal(value(await policy.read(scope)).transferDestinationRef, undefined);
});

test("E2E-256 SET-007 destination catalogue rejects foreign, private, duplicate and malformed host data", async () => {
  const registry = staffedDestinationRegistry(host);
  const good = value(await listStaffedDestinations(registry, scope));
  assert.deepEqual(good.scope, scope);
  const malformed: unknown[] = [
    { ...good, scope: { ...scope, clinicId: "foreign" } },
    { ...good, hostVersion: "" },
    { ...good, patientNotes: "patient-canary" },
    { ...good, options: [{ destinationRef: "host/desk-a", label: "Front desk", patientId: "patient-canary" }] },
    { ...good, options: [good.options[0], good.options[0]] },
    { ...good, options: [{ destinationRef: "host/desk-a", label: " " }] },
    { ...good, options: Array.from({ length: 51 }, (_, index) => ({ destinationRef: `desk-${index}`, label: `Desk ${index}` })) },
    Object.assign([], good),
  ];
  for (const candidate of malformed) {
    assert.deepEqual(await listStaffedDestinations({ resolve: host, list: async () => ok(candidate as StaffedDestinationCatalogue) }, scope), unavailable);
  }
  assert.deepEqual(await listStaffedDestinations({ resolve: host, list: async () => { throw new Error("private adapter detail"); } }, scope), unavailable);
  const returned = value(await listStaffedDestinations({ resolve: host, list: async () => ok(good) }, scope));
  (returned.options[0] as { label: string }).label = "caller-mutated";
  assert.equal(good.options[0]!.label, "Front desk");
  const unsupported = new MemoryPolicyStore("execute", () => now, undefined, undefined,
    { ...registry, resolve: async () => err({ kind: "readinessFailed", missing: ["staffDestination"] }) });
  assert.ok((await unsupported.listStaffedDestinations(scope)).ok);
  assert.deepEqual(await unsupported.changeStaffedDestination(scope, "0", "host/desk-a", "owner"), unavailable);
  assert.equal(value(await unsupported.read(scope)).transferDestinationRef, undefined);
});

test("E2E-256 SET-007 a lost command reply requires current state instead of replaying the route edit", async () => {
  class LostRouteReply extends MemoryPolicyStore {
    override async changeStaffedDestination(...args: Parameters<MemoryPolicyStore["changeStaffedDestination"]>) {
      const result = await super.changeStaffedDestination(...args);
      if (result.ok) throw new Error("synthetic lost route reply");
      return result;
    }
  }
  const policy = new LostRouteReply("execute", () => now, undefined, undefined, staffedDestinationRegistry(host));
  const admin = new CommandGateway({ actorRef: "owner", role: "clinicAdmin", scope }, policy,
    new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], [])));
  const command = { kind: "settings.routing.staffedDestination.change.v1", expectedVersion: "0", destinationRef: "host/desk-a" } as const;
  assert.deepEqual(await admin.submit(command), { ok: false, error: { kind: "commandOutcomeUnknown" } });
  const actual = value(await admin.submit({ kind: "settings.read.v1" }));
  assert.equal(actual.kind, "settings");
  if (actual.kind !== "settings") throw new Error("wrong settings reply");
  assert.equal(actual.policy.policyVersion, "1");
  assert.equal(actual.policy.transferDestinationRef, "host/desk-a");
  assert.deepEqual(await admin.submit(command), { ok: false, error: { kind: "versionConflict" } });
  assert.equal(value(await policy.listStaffedDestinationChanges(scope)).entries.length, 1);
});
