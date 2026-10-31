import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { ClinikoGuardianContactReader } from "../../src/cliniko/guardian-contact.ts";
import type { ClinicGuardianIdentityRecord } from "../../src/cliniko/guardian-contact.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";

const scope = { tenantId: "guardian-tenant", clinicId: "clinic", locationId: "location" };
const phone = "+61400111222", apiKey = "synthetic-guardian-contact-au5";
const record = (): ClinicGuardianIdentityRecord => ({ kind: "guardianIdentity", scope, revision: "approval-1", approverRef: "clinic-admin",
  approvedAt: "2026-10-29T00:00:00.000Z", effectiveFrom: "2026-10-30T00:00:00.000Z", effectiveUntil: "2026-11-01T00:00:00.000Z",
  approved: true, enabled: true, policyVersion: "policy-1", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey),
  recordRef: "guardian-record-1", recordVersion: "record-1", contactId: "19" });
const account = (): AdminAccount => ({ email: "staff@example.test", actor: { actorRef: "clinic-admin", role: "clinicAdmin", scope }, membershipVersion: "member-1" });
const contact = () => ({ id: "19", archived_at: null, deleted_at: null, type_code: 2, type: "Standard", updated_at: "2026-10-30T08:00:00Z",
  links: { self: "https://api.au5.cliniko.com/v1/contacts/19" }, email: "Guardian@EXAMPLE.test",
  phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }], notes: "private-contact-notes-canary", company_name: "private-company-canary" });
function fixture() {
  const state: { record: unknown; member: AdminAccount | undefined; contact: unknown; now: string; status: number;
    beforeResponse?: () => void | Promise<void>; beforeRecord?: (n: number) => void | Promise<void>; beforeMember?: (n: number) => void | Promise<void> } = {
    record: record(), member: account(), contact: contact(), now: "2026-10-31T00:00:00.000Z", status: 200,
  };
  const calls = { source: 0, member: 0, native: 0 }, budget = new ClinikoReadBudget(180);
  const config: ConstructorParameters<typeof ClinikoGuardianContactReader>[0] = {
    scope, policyVersion: "policy-1", businessId: "11", apiKey, contactEmail: "test@example.test", countryCallingCode: "61", rateBudget: budget,
    records: { read: async query => {
      assert.deepEqual(query.scope, scope); assert.equal(query.normalizedPhone, phone); assert.equal(query.credentialFingerprint, clinikoCredentialFingerprint(apiKey));
      calls.source++; await state.beforeRecord?.(calls.source); return ok(state.record);
    } },
    directory: { findByRef: async ref => { assert.equal(ref, "clinic-admin"); calls.member++; await state.beforeMember?.(calls.member); return ok(state.member); } },
    clock: () => state.now,
  };
  const fetchPort: typeof fetch = async (url, init) => {
    calls.native++; assert.equal(String(url), "https://api.au5.cliniko.com/v1/contacts/19");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (test@example.test)");
    await state.beforeResponse?.();
    return state.status === 200 ? Response.json(state.contact) : new Response(null, { status: state.status });
  };
  const reader = new ClinikoGuardianContactReader(config, fetchPort);
  const read = () => reader.read(scope, phone, new AbortController().signal);
  return { state, calls, config, budget, fetchPort, reader, read };
}

test("guardian contact requires an independent current clinic record and reads a non-patient Standard contact", async () => {
  const f = fixture(), result = await f.read(); assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { kind: "guardianContact", scope, policyVersion: "policy-1", businessId: "11",
    credentialFingerprint: clinikoCredentialFingerprint(apiKey), recordRef: "guardian-record-1", recordVersion: "record-1", revision: "approval-1",
    effectiveUntil: "2026-11-01T00:00:00.000Z", contactId: "19", registeredEmail: "Guardian@example.test", contactUpdatedAt: "2026-10-30T08:00:00Z" });
  assert.deepEqual(f.calls, { source: 3, member: 2, native: 1 });
  assert.equal("patientRef" in result.value, false); assert.equal("verificationRef" in result.value, false);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.scope));
});

test("guardian contact refuses absent or ambiguous records before native contact or patient reads", async () => {
  for (const value of [undefined, null, [], [record(), { ...record(), recordRef: "other-record" }]]) {
    const f = fixture(); f.state.record = value; assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 0);
  }
});

test("guardian contact binds approval to exact clinic location business policy and physical credential", async () => {
  const changes = [{ scope: { ...scope, tenantId: "other" } }, { scope: { ...scope, locationId: "other" } },
    { businessId: "12" }, { policyVersion: "policy-2" }, { credentialFingerprint: clinikoCredentialFingerprint("another-account-au5") },
    { contactId: "../19" }, { kind: "patientIdentity" }, { recordRef: "" }, { recordVersion: "" }, { extraPrivateField: "unexpected" }];
  for (const change of changes) {
    const f = fixture(); f.state.record = { ...record(), ...change };
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 0);
  }
});

test("guardian contact rejects unapproved disabled not-yet-effective expired and malformed approvals", async () => {
  for (const change of [{ approved: false }, { enabled: false }, { effectiveFrom: "2026-10-31T01:00:00.000Z" },
    { effectiveUntil: "2026-10-31T00:00:00.000Z" }, { approvedAt: "2026-10-31T01:00:00.000Z" }, { effectiveUntil: "2026-11-31T00:00:00.000Z" }]) {
    const f = fixture(); f.state.record = { ...record(), ...change };
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 0);
  }
});

test("guardian record approval requires the current exact clinic administrator membership", async () => {
  for (const value of [undefined, { ...account(), actor: { ...account().actor, role: "staff" as const } },
    { ...account(), actor: { ...account().actor, scope: { ...scope, clinicId: "other" } } },
    { ...account(), actor: { ...account().actor, actorRef: "different-admin" } }]) {
    const f = fixture(); f.state.member = value; assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 0);
  }
});

test("guardian native contact must be the exact active Standard identity with its own registered non-fax channel", async () => {
  const changes = [{ id: "20" }, { archived_at: "2026-10-31T00:00:00Z" }, { deleted_at: "2026-10-31T00:00:00Z" },
    { type_code: 0, type: "Doctor" }, { type_code: 1, type: "3rd Party Payer" }, { type: "Doctor" },
    { links: { self: "https://api.au5.cliniko.com/v1/patients/19" } }, { links: { self: "https://api.au1.cliniko.com/v1/contacts/19" } },
    { email: null }, { email: "bad@example.test\r\nBcc: another@example.test" }, { updated_at: null },
    { phone_numbers: [{ number: phone, phone_type: "Fax" }] }, { phone_numbers: [{ number: "+61400999888", phone_type: "Mobile" }] },
    { phone_numbers: [{ number: 42 }] }, { phone_numbers: Array(21).fill({ number: phone, phone_type: "Mobile" }) }];
  for (const change of changes) {
    const f = fixture(); f.state.contact = { ...contact(), ...change };
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 1);
  }
});

test("guardian record withdrawal rotation or shared-object mutation while native read is held defeats the result", async () => {
  for (const change of [{ approved: false }, { recordVersion: "record-2" }, { contactId: "20" }, { revision: "approval-2" }]) {
    const f = fixture(); const shared = { ...record() }; f.state.record = shared;
    let reached: () => void = () => undefined, release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforeResponse = async () => { reached(); await resume; };
    const pending = f.read(); await held; Object.assign(shared, change); release();
    assert.equal((await pending).ok, false); assert.equal(f.calls.native, 1);
  }
});

test("guardian membership removal or rotation during native I/O invalidates the complete approval snapshot", async () => {
  for (const replacement of [undefined, { ...account(), membershipVersion: "member-2" }]) {
    const f = fixture(); f.state.beforeResponse = () => { f.state.member = replacement; };
    assert.equal((await f.read()).ok, false);
  }
});

test("guardian record withdrawal during final membership lookup cannot produce a late accepted contact", async () => {
  const f = fixture(); f.state.beforeMember = n => { if (n === 2) f.state.record = { ...record(), enabled: false }; };
  assert.equal((await f.read()).ok, false); assert.equal(f.calls.source, 3);
});

test("guardian approval expiry and an invalid clock after native I/O refuse contact evidence", async () => {
  for (const now of ["2026-11-01T00:00:00.000Z", "invalid-clock"]) {
    const f = fixture(); f.state.beforeResponse = () => { f.state.now = now; }; assert.equal((await f.read()).ok, false);
  }
});

test("guardian native contact rejects a normalized impossible date while preserving valid fractional provider dates", async () => {
  const f = fixture(); f.state.contact = { ...contact(), updated_at: "2026-02-30T08:00:00Z" };
  assert.equal((await f.read()).ok, false);
  f.state.contact = { ...contact(), updated_at: "2026-10-30T08:00:00.123456Z" };
  assert.equal((await f.read()).ok, true);
});

test("guardian scope mismatch malformed phone and pre-abort cannot start record or native discovery", async () => {
  const f = fixture(), aborted = new AbortController(); aborted.abort();
  for (const [bound, number, signal] of [[{ ...scope, locationId: "other" }, phone, new AbortController().signal],
    [scope, "0400111222", new AbortController().signal], [scope, phone, aborted.signal]] as const)
    assert.equal((await f.reader.read(bound, number, signal)).ok, false);
  assert.deepEqual(f.calls, { source: 0, member: 0, native: 0 });
});

test("guardian close during non-cooperative clinic lookup returns promptly and late lookup cannot fetch native data", async () => {
  const f = fixture(), controller = new AbortController(); let release: () => void = () => undefined, entered: () => void = () => undefined;
  const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  f.state.beforeRecord = async () => { entered(); await resume; };
  const pending = f.reader.read(scope, phone, controller.signal); await held; controller.abort();
  assert.equal((await pending).ok, false); release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.native, 0);
});

test("guardian contact claims the shared native budget and provider cooldown blocks the next contact read", async () => {
  const f = fixture(); f.state.status = 429;
  assert.equal((await f.read()).ok, false); assert.equal((await f.read()).ok, false); assert.equal(f.calls.native, 1);
  const exhausted = fixture(); const limited = new ClinikoReadBudget(1); limited.claim();
  const reader = new ClinikoGuardianContactReader({ ...exhausted.config, rateBudget: limited }, exhausted.fetchPort);
  assert.equal((await reader.read(scope, phone, new AbortController().signal)).ok, false); assert.equal(exhausted.calls.native, 0);
});

test("guardian native failures malformed oversized private bodies and thrown record sources yield no identity", async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: "https://example.test" } }), new Response(null, { status: 503 }),
    new Response("{"), new Response("x".repeat(1_000_001))]) {
    const f = fixture(), reader = new ClinikoGuardianContactReader(f.config, async () => response);
    assert.equal((await reader.read(scope, phone, new AbortController().signal)).ok, false);
  }
  const f = fixture(); f.state.beforeRecord = () => { throw new Error("private source detail"); };
  const result = await f.read(); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("private"), false); assert.equal(f.calls.native, 0);
});

test("guardian contact native cost accounts for every declared owner read and never declares unknown work free", () => {
  const f = fixture(), binding = { scope, credentialFingerprint: clinikoCredentialFingerprint(apiKey), budget: f.budget };
  assert.equal(f.reader.nativeRequestCostCeiling(binding), undefined);
  const records = { read: declareClinikoRequestCost(f.config.records.read, binding, 2) },
    directory = { findByRef: declareClinikoRequestCost(f.config.directory.findByRef, binding, 1) };
  const reader = new ClinikoGuardianContactReader({ ...f.config, records, directory }, f.fetchPort);
  assert.equal(reader.nativeRequestCostCeiling(binding), 9);
  assert.equal(reader.nativeRequestCostCeiling({ ...binding, budget: new ClinikoReadBudget(180) }), undefined);
  assert.equal(reader.nativeRequestCostCeiling({ ...binding, credentialFingerprint: clinikoCredentialFingerprint("other-au5") }), undefined);
  class Override extends ClinikoGuardianContactReader {}
  assert.equal(new Override({ ...f.config, records, directory }).nativeRequestCostCeiling(binding), undefined);
});

test("guardian contact captures configured method receivers without freezing the source's current record decisions", async () => {
  const f = fixture();
  const records = { marker: "original", read: async function(query: Parameters<typeof f.config.records.read>[0]) {
    assert.equal(this.marker, "original"); return f.config.records.read(query);
  } };
  const directory = { marker: "original", findByRef: async function(ref: string) {
    assert.equal(this.marker, "original"); return f.config.directory.findByRef(ref);
  } };
  const incoming = { ...f.config, records, directory }, reader = new ClinikoGuardianContactReader(incoming, f.fetchPort);
  incoming.records = { ...records, marker: "replacement" }; incoming.directory = { ...directory, marker: "replacement" };
  assert.equal((await reader.read(scope, phone, new AbortController().signal)).ok, true);
  f.state.record = { ...record(), enabled: false };
  assert.equal((await reader.read(scope, phone, new AbortController().signal)).ok, false);
});
