import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand, HostActor } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { matchesSchema } from "../../src/reference/schema-shapes.ts";
import { listNotificationOptions, validNotificationCatalogue, NOTIFICATION_LABELS } from "../../src/core/notification-policy.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";
import type { NotificationCatalogue } from "../../src/core/notification-policy.ts";

const now = "2026-10-02T21:40:00.000Z";
const ids = ["settings.notifications.owner.change.v1", "settings.notifications.audit.v1", "settings.notifications.options.v1"] as const;
function fixture() {
  const scope = { tenantId: `notifications-gateway-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const policy = new MemoryPolicyStore(undefined, () => now, undefined, undefined, undefined, notificationRegistry());
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const gateway = (role: HostActor["role"], bound = scope, actorRef = `${role}-owner`) => new CommandGateway({ actorRef, role, scope: bound }, policy, reception);
  return { scope, policy, reception, gateway, admin: gateway("clinicAdmin") };
}

test("E2E-257 notification commands expose typed clinic CAS and host preconditions only to clinic admins", async () => {
  const app = fixture();
  for (const id of ids) assert.ok(app.admin.listPermitted().some(item => item.id === id));
  for (const role of ["agent", "staff"] as const) {
    const gateway = app.gateway(role);
    assert.equal(gateway.listPermitted().some(item => ids.some(id => id === item.id)), false);
    for (const command of [
      { kind: ids[0], expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "host" },
      { kind: ids[1] }, { kind: ids[2] },
    ] as const) assert.deepEqual(await gateway.submit(command), { ok: false, error: { kind: "forbidden" } });
  }
  const descriptor = app.admin.listPermitted().find(item => item.id === ids[0])!;
  assert.equal(descriptor.effect, "policyChange");
  assert.equal(descriptor.authority, "clinicAdmin");
  assert.deepEqual(descriptor.preconditions, ["expectedClinicNotificationVersion", "hostManagedNotificationForSet"]);
  const command = { kind: ids[0], expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "abby" } as const;
  assert.equal(matchesSchema(descriptor.inputSchema, command), true);
  const reply = await app.admin.submit(command);
  assert.ok(reply.ok && reply.value.kind === "settings");
  assert.equal(matchesSchema(descriptor.resultSchema, reply), true);
  assert.equal(reply.value.policy.notificationSettings?.version, "1");
  assert.equal(reply.value.policy.notificationBindings?.bookingConfirmation?.owner, "abby");
  assert.equal(reply.value.policy.policyVersion, "0");
});

test("E2E-257 notification admin changes share a clinic version across kinds/locations and capture the authenticated actor", async () => {
  const app = fixture();
  const secondScope = { ...app.scope, locationId: "second" };
  const second = app.gateway("clinicAdmin", secondScope, "second-owner");
  assert.ok((await app.admin.submit({ kind: ids[0], expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "host" })).ok);
  assert.deepEqual(await second.submit({ kind: ids[0], expectedVersion: "0", notificationKind: "cancellationConfirmation", owner: "abby" }),
    { ok: false, error: { kind: "versionConflict" } });
  assert.ok((await second.submit({ kind: ids[0], expectedVersion: "1", notificationKind: "cancellationConfirmation", owner: "abby" })).ok);
  assert.ok((await app.policy.changeBookingEnabled(app.scope, "0", true, "booking-owner")).ok);
  assert.ok((await second.submit({ kind: ids[0], expectedVersion: "2", notificationKind: "bookingConfirmation", owner: null })).ok);
  const audit = await app.admin.submit({ kind: ids[1] });
  assert.ok(audit.ok && audit.value.kind === "notificationSettingAudit");
  assert.deepEqual(audit.value.page.entries.map(row => [row.version, row.kind, row.owner, row.previousOwner, row.actorRef]), [
    ["1", "bookingConfirmation", "host", null, "clinicAdmin-owner"],
    ["2", "cancellationConfirmation", "abby", null, "second-owner"],
    ["3", "bookingConfirmation", null, "host", "second-owner"],
  ]);
  const foreign = app.gateway("clinicAdmin", { ...app.scope, tenantId: "foreign" });
  const isolated = await foreign.submit({ kind: ids[1] });
  assert.ok(isolated.ok && isolated.value.kind === "notificationSettingAudit");
  assert.deepEqual(isolated.value.page.entries, []);
});

test("E2E-257 notification gateway rejects forged actor/scope/host declarations and invalid kinds before a setting changes", async () => {
  const app = fixture();
  const base = { kind: ids[0], expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "host" };
  const bad: unknown[] = [
    { ...base, scope: { ...app.scope, clinicId: "foreign" } }, { ...base, actorRef: "forged-owner" },
    { ...base, hostVersion: "forged-version" }, { ...base, nativeDelivery: "managedOnly" },
    { ...base, owner: "both" }, { ...base, notificationKind: "unknown" }, { ...base, expectedVersion: 0 },
  ];
  for (const command of bad) assert.deepEqual(await app.admin.submit(command as GatewayCommand), { ok: false, error: { kind: "invalid" } });
  const audit = await app.policy.listNotificationChanges(app.scope);
  assert.ok(audit.ok);
  assert.equal(audit.value.entries.length, 0);
});

test("E2E-257 notification save reply loss does not change the typed outcome or replay a committed edit", async () => {
  const app = fixture();
  const original = app.policy.changeNotificationOwner.bind(app.policy);
  app.policy.changeNotificationOwner = async (...args) => {
    const committed = await original(...args);
    assert.ok(committed.ok);
    throw new Error("private transport details after commit");
  };
  const command = { kind: ids[0], expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "abby" } as const;
  assert.deepEqual(await app.admin.submit(command), { ok: false, error: { kind: "commandOutcomeUnknown" } });
  const read = await app.admin.submit({ kind: "settings.read.v1" });
  assert.ok(read.ok && read.value.kind === "settings");
  assert.equal(read.value.policy.notificationSettings?.version, "1");
  assert.equal(read.value.policy.notificationSettings?.owners.bookingConfirmation, "abby");
  const audit = await app.policy.listNotificationChanges(app.scope);
  assert.ok(audit.ok);
  assert.equal(audit.value.entries.length, 1);
  app.policy.changeNotificationOwner = original;
  assert.deepEqual(await app.admin.submit(command), { ok: false, error: { kind: "versionConflict" } });
});

test("E2E-257 notification choices have exact kinds/public labels; malformed or foreign catalogues cannot authorize UI options", async () => {
  const app = fixture();
  const reply = await app.admin.submit({ kind: ids[2] });
  assert.ok(reply.ok && reply.value.kind === "notificationOptions");
  assert.equal(validNotificationCatalogue(reply.value.catalogue, app.scope), true);
  assert.deepEqual(reply.value.catalogue.options.map(option => option.label), Object.values(NOTIFICATION_LABELS));
  const correct = reply.value.catalogue;
  const bad: unknown[] = [
    { ...correct, scope: { ...app.scope, clinicId: "foreign" } },
    { ...correct, options: [correct.options[0], correct.options[0], correct.options[2]] },
    { ...correct, options: correct.options.map(row => ({ ...row, label: "private-provider-detail" })) },
    { ...correct, options: correct.options.map(row => ({ ...row, owners: ["host", "host"] })) },
    { ...correct, options: correct.options.map(row => ({ ...row, owners: [] })) },
    { ...correct, patientRef: "private-data" },
  ];
  for (const value of bad) assert.equal(validNotificationCatalogue(value as NotificationCatalogue, app.scope), false);
  const unavailable = await listNotificationOptions({ resolve: async () => { throw new Error("host unavailable"); } }, app.scope);
  assert.ok(unavailable.ok);
  assert.equal(validNotificationCatalogue(unavailable.value, app.scope), true);
  assert.ok(unavailable.value.options.every(option => option.owners.length === 0 && option.hostVersion === undefined));
});
