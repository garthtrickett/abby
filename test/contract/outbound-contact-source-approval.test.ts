import assert from "node:assert/strict";
import test from "node:test";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { outboundContactSourceFixture } from "../support/outbound-contact-source.ts";
import { OwnerFileOutboundContactSource } from "../../src/standalone/owner-file-outbound-contact-source.ts";
import { contactSourceSelection, ClinikoOutboundContactSource } from "../../src/cliniko/outbound-contact-source.ts";
import { value } from "../support/outbound-records.ts";
const signal = () => new AbortController().signal;
test("current owner-file source binds only non-patient selection and current clinic-admin membership", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close);
  assert.equal(value(await f.definition.currentFor(contactSourceSelection(f.config), signal())), true);
  assert.equal(Object.hasOwn(f.approval, "patientId"), false); assert.equal(Object.hasOwn(f.approval.source, "recipient"), false);
});
for (const change of ["disabled", "unapproved", "sourceChanged", "role", "membership", "removed", "expired", "beforeEffective"] as const)
  test(`source ${change} cannot reuse captured approval`, async t => {
    const f = await outboundContactSourceFixture(); t.after(f.close);
    if (change === "disabled") await f.replace({ enabled: false });
    if (change === "unapproved") await f.replace({ approved: false });
    if (change === "sourceChanged") await f.replace({ source: { ...f.approval.source, contactReviewRecallTypeId: "92" } });
    if (change === "role") f.state.account = { ...f.state.account!, actor: { ...f.state.account!.actor, role: "staff" } };
    if (change === "membership") f.state.account = { ...f.state.account!, membershipVersion: "2" };
    if (change === "removed") f.state.account = undefined;
    if (change === "expired") f.state.now = f.approval.effectiveUntil;
    if (change === "beforeEffective") f.state.now = "2026-10-31T00:00:00.000Z";
    const found = await f.definition.currentFor(contactSourceSelection(f.config), signal()); assert.ok(!found.ok || !found.value);
  });
for (const patch of [{ patientId: "21" }, { headDigest: "a".repeat(64) }, { contactAllowed: true }, { source: { businessId: "11" } }])
  test("local source files refuse private or authority-bearing additions and incomplete selection", async t => {
    const f = await outboundContactSourceFixture(); t.after(f.close); await f.replace(patch);
    assert.equal((await OwnerFileOutboundContactSource.capture(f.definitionConfig, signal())).ok, false);
  });
test("world-readable, linked and oversized approval files cannot establish a source", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const path = f.definitionConfig.path;
  await chmod(path, 0o644); assert.equal((await OwnerFileOutboundContactSource.capture(f.definitionConfig, signal())).ok, false);
  await chmod(path, 0o600); await symlink(path, path + ".link"); assert.equal((await OwnerFileOutboundContactSource.capture({ ...f.definitionConfig, path: path + ".link" }, signal())).ok, false);
  await writeFile(path, " ".repeat(8193)); assert.equal((await OwnerFileOutboundContactSource.capture(f.definitionConfig, signal())).ok, false);
});
test("selection is captured before a held current membership read", { timeout: 3000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); let hold = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const original = f.directory.findByRef;
  f.directory.findByRef = async ref => { if (hold) { entered(); await gate; } return original(ref); };
  const definition = value(await OwnerFileOutboundContactSource.capture(f.definitionConfig, signal())); hold = true;
  const selection = { ...contactSourceSelection(f.config), contactReviewRecallTypeId: "92" }, pending = definition.currentFor(selection, signal());
  await ready; selection.contactReviewRecallTypeId = "91"; release(); assert.deepEqual(await pending, { ok: true, value: false });
});
test("external cancellation bounds held membership without disclosing source", { timeout: 3000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); let hold = false, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), original = f.directory.findByRef;
  f.directory.findByRef = async ref => { if (hold) { entered(); return new Promise(() => {}); } return original(ref); };
  const definition = value(await OwnerFileOutboundContactSource.capture(f.definitionConfig, signal())); hold = true;
  const controller = new AbortController(), pending = definition.currentFor(contactSourceSelection(f.config), controller.signal); await ready; controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
});
test("distinct contact selection and real correction revision owner are mandatory", async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close);
  for (const config of [{ ...f.config, contactReviewRecallTypeId: undefined }, { ...f.config, countryCallingCode: 61 }, { ...f.config, contactPolicyVersion: 1 },
    { ...f.config, contactRevision: { matches: () => false, read: f.config.contactRevision.read } }]) {
    assert.equal(ClinikoOutboundContactSource.create(config as typeof f.config, f.definition, f.authority, f.port).ok, false);
  }
});
