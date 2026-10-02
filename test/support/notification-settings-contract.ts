import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { defaultNotificationSettings } from "../../src/core/notification-policy.ts";
import type { ClinicNotificationSettingStore, NotificationDeclaration, NotificationKind,
  NotificationRegistry } from "../../src/core/notification-policy.ts";

export function notificationRegistry(): NotificationRegistry {
  return { resolve: async (scope, kind) => ok({ scope: structuredClone(scope), kind, hostVersion: "notifications-v1",
    owners: ["host", "abby"], nativeDelivery: "managedOnly", ready: true }) };
}
function scope() { return { tenantId: `notification-${randomUUID()}`, clinicId: "clinic", locationId: "first" }; }

/** Both adapters must exhibit the same clinic ownership, race, rejection and audit behaviour. */
export function notificationSettingsContract(label: string,
  make: (registry: NotificationRegistry) => ClinicNotificationSettingStore): void {
  test(`${label}: notifications start unset and edits retain independent kinds across locations`, async () => {
    const first = scope();
    const second = { ...first, locationId: "second" };
    const store = make(notificationRegistry());
    assert.deepEqual(await store.read(first), ok(defaultNotificationSettings()));
    assert.ok((await store.changeOwner(first, "0", "bookingConfirmation", "host", "owner-first")).ok);
    assert.ok((await store.changeOwner(second, "1", "cancellationConfirmation", "abby", "owner-second")).ok);
    assert.ok((await store.changeOwner(second, "2", "reschedulingConfirmation", "host", "owner-second")).ok);
    const read = await store.read(first);
    assert.ok(read.ok);
    assert.deepEqual(read.value, { version: "3", owners: {
      bookingConfirmation: "host", cancellationConfirmation: "abby", reschedulingConfirmation: "host" } });
    // A caller cannot mutate the stored preferences through a returned JSON object.
    const mutable = read.value.owners as Record<string, unknown>;
    mutable.bookingConfirmation = "abby";
    assert.deepEqual(await store.read(second), ok({ version: "3", owners: {
      bookingConfirmation: "host", cancellationConfirmation: "abby", reschedulingConfirmation: "host" } }));
    assert.deepEqual(await store.read({ ...first, tenantId: `${first.tenantId}-other` }), ok(defaultNotificationSettings()));
    assert.deepEqual(await store.read({ ...first, clinicId: "other" }), ok(defaultNotificationSettings()));
    const audit = await store.listChanges(second);
    assert.ok(audit.ok);
    assert.deepEqual(audit.value.entries.map(row => [row.version, row.kind, row.owner, row.previousOwner, row.actorRef]), [
      ["1", "bookingConfirmation", "host", null, "owner-first"],
      ["2", "cancellationConfirmation", "abby", null, "owner-second"],
      ["3", "reschedulingConfirmation", "host", null, "owner-second"],
    ]);
    for (const entry of audit.value.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ["version", "kind", "owner", "previousOwner", "actorRef", "changedAt"].sort());
      assert.ok(Number.isFinite(Date.parse(entry.changedAt)));
    }
  });
  test(`${label}: competing kinds and locations have exactly one clinic version winner`, async () => {
    const first = scope();
    const store = make(notificationRegistry());
    const outcomes = await Promise.all([
      store.changeOwner(first, "0", "bookingConfirmation", "host", "first-owner"),
      store.changeOwner({ ...first, locationId: "second" }, "0", "cancellationConfirmation", "abby", "second-owner"),
    ]);
    assert.equal(outcomes.filter(row => row.ok).length, 1);
    assert.deepEqual(outcomes.filter(row => !row.ok), [{ ok: false, error: { kind: "versionConflict" } }]);
    const history = await store.listChanges(first);
    assert.ok(history.ok);
    assert.equal(history.value.entries.length, 1);
    assert.equal(history.value.entries[0]!.version, "1");
  });
  test(`${label}: invalid input and invalid audit cursors cannot create history`, async () => {
    const first = scope();
    const store = make(notificationRegistry());
    const bad: unknown[][] = [
      [first, "01", "bookingConfirmation", "host", "owner"],
      [first, "-1", "bookingConfirmation", "host", "owner"],
      [first, "2147483647", "bookingConfirmation", "host", "owner"],
      [first, "0", "unknownKind", "host", "owner"],
      [first, "0", "bookingConfirmation", "both", "owner"],
      [first, "0", "bookingConfirmation", undefined, "owner"],
      [first, "0", "bookingConfirmation", "host", " "],
      [{ ...first, locationId: "" }, "0", "bookingConfirmation", "host", "owner"],
      [null, "0", "bookingConfirmation", "host", "owner"],
    ];
    for (const args of bad) assert.deepEqual(await store.changeOwner(...args as Parameters<ClinicNotificationSettingStore["changeOwner"]>),
      { ok: false, error: { kind: "invalidValue" } });
    for (const cursor of [-1, 1.5, NaN, Infinity, 2147483648]) assert.deepEqual(await store.listChanges(first, cursor),
      { ok: false, error: { kind: "invalidValue" } });
    assert.deepEqual(await store.read(first), ok(defaultNotificationSettings()));
    assert.deepEqual(await store.listChanges(first), ok({ entries: [] }));
  });
  test(`${label}: malformed, unscoped and auto-sending host declarations cannot grant an owner`, async () => {
    const first = scope();
    const valid: NotificationDeclaration = { scope: first, kind: "bookingConfirmation", hostVersion: "v1",
      owners: ["host", "abby"], nativeDelivery: "managedOnly", ready: true };
    const bad: unknown[] = [
      { ...valid, scope: { ...first, tenantId: "other" } },
      { ...valid, scope: { ...first, clinicId: "other" } },
      { ...valid, scope: { ...first, locationId: "second" } },
      { ...valid, kind: "cancellationConfirmation" },
      { ...valid, hostVersion: " " },
      { ...valid, nativeDelivery: "automatic" },
      { ...valid, ready: false }, { ...valid, owners: [] },
      { ...valid, owners: ["host", "host"] }, { ...valid, owners: ["host"] },
      { ...valid, patient: "private-data" }, null,
    ];
    for (const declaration of bad) {
      const store = make({ resolve: async () => ok(declaration as NotificationDeclaration) });
      assert.deepEqual(await store.changeOwner(first, "0", "bookingConfirmation", "abby", "owner"),
        { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } });
      assert.deepEqual(await store.read(first), ok(defaultNotificationSettings()));
      assert.deepEqual(await store.listChanges(first), ok({ entries: [] }));
    }
  });
  test(`${label}: clear remains available after host withdrawal; stale writes do not call the host`, async () => {
    const first = scope();
    let withdrawn = false;
    let reads = 0;
    const registry = notificationRegistry();
    const store = make({ resolve: async (...args) => {
      reads += 1;
      if (withdrawn) throw new Error("host unavailable");
      return registry.resolve(...args);
    } });
    assert.ok((await store.changeOwner(first, "0", "bookingConfirmation", "host", "owner")).ok);
    withdrawn = true;
    assert.deepEqual(await store.changeOwner(first, "0", "bookingConfirmation", "abby", "owner"),
      { ok: false, error: { kind: "versionConflict" } });
    assert.equal(reads, 1);
    assert.deepEqual(await store.changeOwner(first, "1", "bookingConfirmation", "abby", "owner"),
      { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } });
    assert.ok((await store.changeOwner(first, "1", "bookingConfirmation", null, "owner")).ok);
    assert.equal(reads, 2);
    const history = await store.listChanges(first);
    assert.ok(history.ok);
    assert.deepEqual(history.value.entries.map(row => [row.owner, row.previousOwner]), [["host", null], [null, "host"]]);
  });
  test(`${label}: a host preflight race cannot overwrite an intervening clinic change`, async () => {
    const first = scope();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const registry = notificationRegistry();
    const store = make({ resolve: async (...args) => { entered(); await waiting; return registry.resolve(...args); } });
    const late = store.changeOwner(first, "0", "bookingConfirmation", "abby", "late-owner");
    await started;
    const winner = await store.changeOwner({ ...first, locationId: "second" }, "0", "cancellationConfirmation", null, "winner");
    assert.ok(winner.ok);
    release();
    assert.deepEqual(await late, { ok: false, error: { kind: "versionConflict" } });
    const history = await store.listChanges(first);
    assert.ok(history.ok);
    assert.deepEqual(history.value.entries.map(row => row.actorRef), ["winner"]);
  });
  test(`${label}: clinic audit pages are ordered, scoped and do not alias storage`, async () => {
    const first = scope();
    const store = make(notificationRegistry());
    for (let index = 0; index < 52; index++) {
      const kind: NotificationKind = index % 2 ? "bookingConfirmation" : "cancellationConfirmation";
      assert.ok((await store.changeOwner(first, String(index), kind, index % 3 ? "host" : null, "owner")).ok);
    }
    const second = { ...first, locationId: "second" };
    const page = await store.listChanges(second);
    assert.ok(page.ok);
    assert.equal(page.value.entries.length, 50);
    assert.equal(page.value.nextAfterVersion, 50);
    (page.value.entries[0] as { actorRef: string }).actorRef = "forged";
    const fresh = await store.listChanges(first);
    assert.ok(fresh.ok);
    assert.equal(fresh.value.entries[0]!.actorRef, "owner");
    const next = await store.listChanges(first, page.value.nextAfterVersion);
    assert.ok(next.ok);
    assert.deepEqual(next.value.entries.map(row => row.version), ["51", "52"]);
    assert.equal(next.value.nextAfterVersion, undefined);
    assert.deepEqual(await store.listChanges({ ...first, clinicId: "other" }), ok({ entries: [] }));
  });
}
