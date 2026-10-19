import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { outboundContactAccountFixture } from "../support/outbound-contact-account.ts";
import { value } from "../support/outbound-records.ts";
import { OwnerFileOutboundContactAccount } from "../../src/standalone/owner-file-outbound-contact-account.ts";

test("current clinic account coverage preserves independently approved source roles across locations without patient state", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close); const found = value(await f.read()); assert.ok(found);
  assert.equal(found.account.sources.length, 2); assert.equal(found.account.coverage, "allCurrentAndRetiredVoiceContactSources");
  assert.equal(Object.isFrozen(found.account.sources[0]!.scope), true); assert.equal(Object.isFrozen(found.account.credentialFingerprints), true);
  assert.equal(f.owner.matches(f.first.request.scope, f.first.request.credentialFingerprint), true);
  assert.equal(f.owner.matches(f.second.request.scope, f.first.request.credentialFingerprint), false);
  assert.match(f.owner.bindingFingerprint(), /^[a-f0-9]{64}$/);
  const raw = await readFile(f.config.path, "utf8"); for (const privateField of ["patientId", "recipient", "number", f.first.request.recipient.number]) assert.equal(raw.includes(privateField), false);
});
for (const change of ["disabled", "file", "membership", "role", "scope", "expiry", "clock"] as const)
  test(`account approval cannot remain current after ${change}`, async t => {
    const f = await outboundContactAccountFixture(); t.after(f.close);
    if (change === "disabled") await f.replace({ enabled: false });
    if (change === "file") await f.replace({ revision: "changed" });
    if (change === "membership") f.first.state.account = undefined;
    if (change === "role") f.first.state.account = { ...f.first.state.account!, actor: { ...f.first.state.account!.actor, role: "staff" } };
    if (change === "scope") f.first.state.account = { ...f.first.state.account!, actor: { ...f.first.state.account!.actor, scope: f.second.request.scope } };
    if (change === "expiry") f.first.state.now = "2026-12-01T00:00:00.000Z";
    if (change === "clock") f.first.state.now = "2026-11-01T00:00:00.000Z";
    const found = await f.read(); assert.equal(found.ok && !!found.value, false);
  });
for (const role of ["first", "second"] as const)
  test(`an unavailable independently approved ${role} location source cannot disappear from coverage`, async t => {
    const f = await outboundContactAccountFixture(); t.after(f.close); await f[role].replace({ enabled: false });
    assert.equal((await f.read()).ok, false);
  });
for (const change of ["extraPrivate", "missingHistorical", "duplicate", "undeclaredAlias", "duplicateAlias", "foreignClinic", "foreignTenant", "unknownCoverage"] as const)
  test(`closed source-role coverage rejects ${change}`, async t => {
    const f = await outboundContactAccountFixture(); t.after(f.close); let account = structuredClone(f.approval.account);
    if (change === "extraPrivate") Object.assign(account, { phone: f.first.request.recipient.number });
    if (change === "missingHistorical") Object.assign(account, { sources: [account.sources[0]] });
    if (change === "duplicate") Object.assign(account, { sources: [account.sources[0], account.sources[0]] });
    if (change === "undeclaredAlias") Object.assign(account, { credentialFingerprints: ["a".repeat(64)] });
    if (change === "duplicateAlias") Object.assign(account, { credentialFingerprints: [f.first.request.credentialFingerprint, f.first.request.credentialFingerprint] });
    if (change === "foreignClinic" || change === "foreignTenant") Object.assign(account.sources[0]!.scope, change === "foreignClinic" ? { clinicId: "foreign" } : { tenantId: "foreign" });
    if (change === "unknownCoverage") Object.assign(account, { coverage: "currentSourcesOnly" });
    await f.replace({ account }); assert.equal((await f.make()).ok, false);
  });
test("removing a configured independently approved source is refused even when the file still lists it", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close); f.config.definitions.pop(); assert.equal((await f.make()).ok, false);
  assert.ok(value(await f.read()));
});
test("captured source methods cannot be replaced to reverse a denial", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close); await f.second.replace({ enabled: false });
  Object.assign(f.config.definitions[1]!.definition, { currentFor: async () => ({ ok: true, value: true }) });
  assert.equal((await f.read()).ok, false);
});
test("file membership and definitions cannot drift across an approval wait", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close); let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
  const original = f.config.directory.findByRef;
  Object.assign(f.config.directory, { findByRef: async (ref: string) => { reached(); await held; return original(ref); } });
  const capture = f.make(); await started;
  f.config.definitions.pop(); release(); const captured = value(await capture);
  assert.equal(value(await captured.current(new AbortController().signal))?.account.sources.length, 2);
});
test("unknown time and an explicit abort cannot become current coverage", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close); const c = new AbortController(); c.abort();
  assert.equal((await f.read(c.signal)).ok, false); assert.equal((await f.make(c.signal)).ok, false);
  assert.equal((await OwnerFileOutboundContactAccount.capture({ ...f.config, clock: () => undefined as unknown as string }, new AbortController().signal)).ok, false);
});
test("a held source definition obeys the account deadline", { timeout: 3000 }, async t => {
  const f = await outboundContactAccountFixture({ deadlineMs: 100 }); t.after(f.close);
  const definitions = f.config.definitions.map(d => ({ ...d, definition: { currentFor: () => new Promise<never>(() => {}) } }));
  assert.equal((await OwnerFileOutboundContactAccount.capture({ ...f.config, definitions }, new AbortController().signal)).ok, false);
});

test("guarded account requires a canonical random guard while legacy read-only account stays unchanged", async t => {
  const f = await outboundContactAccountFixture(); t.after(f.close);
  const original = value(await f.read()); assert.ok(original); assert.equal(Object.hasOwn(original.account, "contactGuardRef"), false);
  const guardRef = randomUUID(); await f.replace({ account: { ...f.approval.account, contactGuardRef: guardRef } });
  const guarded = value(await f.make()), current = value(await guarded.current(new AbortController().signal)); assert.equal(current?.account.contactGuardRef, guardRef);
  for (const bad of ["", "patient:22", "00000000-0000-0000-0000-000000000000", null]) {
    await f.replace({ account: { ...f.approval.account, contactGuardRef: bad } }); assert.equal((await f.make()).ok, false);
  }
});
