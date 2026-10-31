import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { ok } from "../../src/core/model.ts";
import { GuardianPatientAuthority } from "../../src/standalone/guardian-patient-authority.ts";
import type { ClinicGuardianPatientAuthorityRecord, ClinicGuardianPatientAuthorityRecords } from "../../src/standalone/guardian-patient-authority.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";
import { guardianVerificationFixture } from "../support/guardian-verification.ts";

const identity = { firstName: "PrivateChild", lastName: "SelectionCanary", dateOfBirth: "2017-02-28" };
async function fixture(options: Readonly<{ declaredCosts?: boolean; allowedAuthorities?: readonly ("guardian" | "adultRepresentative")[] }> = {}) {
  const g = await guardianVerificationFixture(options), approval = g.state.record;
  const record: ClinicGuardianPatientAuthorityRecord = { scope: g.f.scope, revision: "subject-approval-1", approverRef: approval.approverRef,
    approvedAt: approval.approvedAt, effectiveFrom: approval.effectiveFrom, effectiveUntil: approval.effectiveUntil, approved: true, enabled: true,
    kind: "guardianPatientAuthority", policyVersion: approval.policyVersion, businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint,
    authorityRef: "private-authority-record-1", authorityVersion: "authority-version-1", contactId: approval.contactId,
    identityRecordRef: approval.recordRef, identityRecordVersion: approval.recordVersion, identityRevision: approval.revision,
    subjectPatientId: "192837465019283746", operation: "appointments.book", authorityKind: "guardian", subjectKind: "minor", purposes: ["identify", "channel", "operation"] };
  const state: { record: unknown; member: AdminAccount | undefined; beforeRead?: (n: number, query: Parameters<ClinicGuardianPatientAuthorityRecords["read"]>[0]) => void | Promise<void>;
    beforeMember?: (n: number) => void | Promise<void> } = { record, member: structuredClone(g.f.account) };
  const calls = { records: 0, members: 0 };
  const records: ClinicGuardianPatientAuthorityRecords = { read: async query => {
    calls.records++; assert.deepEqual(query.scope, g.f.scope); assert.deepEqual(query.identity, identity);
    assert.equal(query.guardian.kind, "verifiedGuardian"); assert.equal(query.guardian.recordRef, approval.recordRef);
    assert.equal(query.operation, "appointments.book"); assert.ok(query.signal instanceof AbortSignal);
    await state.beforeRead?.(calls.records, query); return ok(state.record);
  } };
  const directory = { findByRef: async (ref: string) => {
    calls.members++; assert.equal(ref, approval.approverRef); await state.beforeMember?.(calls.members); return ok(state.member);
  } };
  if (options.declaredCosts) {
    records.read = declareClinikoRequestCost(records.read, g.binding, 2);
    directory.findByRef = declareClinikoRequestCost(directory.findByRef, g.binding, 1);
  }
  const config: ConstructorParameters<typeof GuardianPatientAuthority>[0] = { scope: g.f.scope, callId: g.f.callId, sessionId: g.f.sessionId,
    policyVersion: approval.policyVersion, businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint,
    budget: g.config.account.budget, actor: g.session, policy: g.policy, records, directory, clock: g.config.clock!, signal: g.lifetime.signal };
  const reader = new GuardianPatientAuthority(config), signal = new AbortController().signal;
  return { g, record, state, calls, config, reader, read: (purpose: "identify" | "channel" | "operation" = "identify") => reader.read(identity, "appointments.book", purpose, signal) };
}

test("a verified guardian still needs an independent current clinic subject and action record", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.records, 0);
    const proof = await f.g.issue(), found = await f.read(); assert.ok(found.ok); if (!found.ok) return;
    assert.deepEqual(found.value.guardian, proof); assert.deepEqual(found.value.record, f.record);
    assert.deepEqual(f.calls, { records: 3, members: 2 });
    assert.match(found.value.approvalMembershipFingerprint, /^[a-f0-9]{64}$/);
    assert.equal("verificationRef" in found.value.record, false); assert.equal("patientRef" in found.value.guardian, false);
    assert.deepEqual(f.g.f.provider, []); assert.ok(f.g.native.every(path => path.includes("/contacts/")));
    const stored = JSON.stringify(await f.g.f.state());
    for (const canary of [identity.firstName, identity.lastName, identity.dateOfBirth, f.record.subjectPatientId, f.record.authorityRef]) assert.equal(stored.includes(canary), false);
  } finally { await f.g.close(); }
});

test("identity approval absent ambiguous or generic family information cannot supply patient authority", async () => {
  const f = await fixture();
  try {
    await f.g.issue();
    for (const value of [undefined, null, [], [f.record, f.record], f.g.state.record, { contactId: f.record.contactId, relationship: "parent" }]) {
      f.state.record = value; assert.equal((await f.read()).ok, false);
    }
    assert.equal(f.calls.members, 0); assert.deepEqual(f.g.f.provider, []);
  } finally { await f.g.close(); }
});

test("guardian authority binds exact scope account identity approval version subject and single action", async () => {
  const f = await fixture();
  try {
    await f.g.issue();
    for (const patch of [{ scope: { ...f.record.scope, locationId: "other" } }, { scope: { ...f.record.scope, tenantId: "other" } },
      { businessId: "12" }, { credentialFingerprint: clinikoCredentialFingerprint("foreign-au5") }, { policyVersion: "other" },
      { contactId: "19" }, { identityRecordRef: "other" }, { identityRecordVersion: "other" }, { identityRevision: "other" },
      { subjectPatientId: "../patients/11" }, { operation: "appointments.cancel" }, { authorityRef: "" }, { authorityVersion: "" },
      { kind: "guardianIdentity" }, { extra: "unapproved" }]) {
      f.state.record = { ...f.record, ...patch }; assert.equal((await f.read()).ok, false);
    }
    assert.equal(f.calls.members, 0);
  } finally { await f.g.close(); }
});

test("guardian authority requires current enabled approval and valid effective dates", async () => {
  const f = await fixture();
  try {
    await f.g.issue();
    for (const patch of [{ approved: false }, { enabled: false }, { effectiveUntil: f.config.clock() },
      { effectiveFrom: "2026-10-05T00:00:00.000Z" }, { approvedAt: "2026-10-05T00:00:00.000Z" }, { effectiveUntil: "2026-11-31T00:00:00.000Z" }]) {
      f.state.record = { ...f.record, ...patch }; assert.equal((await f.read()).ok, false);
    }
    assert.equal(f.calls.members, 0);
  } finally { await f.g.close(); }
});

test("separate identify channel and operation permission cannot be inferred from an identity match", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); f.state.record = { ...f.record, purposes: ["identify"] };
    assert.equal((await f.read("identify")).ok, true); assert.equal((await f.read("channel")).ok, false); assert.equal((await f.read("operation")).ok, false);
    for (const value of [[], ["identify", "identify"], ["identify", "writeAnything"], "operation"])
      { f.state.record = { ...f.record, purposes: value }; assert.equal((await f.read()).ok, false); }
  } finally { await f.g.close(); }
});

test("adult representative authority needs an explicit process approval and exact adult subject kind", async () => {
  const f = await fixture();
  try {
    for (const allowedAuthorities of [[], ["guardian", "guardian"], ["unrestricted"]]) {
      await f.g.replaceApproval({ allowedAuthorities: allowedAuthorities as never }); assert.equal((await f.g.policy.current(f.g.f.scope)).ok, false);
    }
    await f.g.replaceApproval({ allowedAuthorities: ["guardian"] }); await f.g.issue();
    for (const patch of [{ authorityKind: "adultRepresentative", subjectKind: "adult" }, { authorityKind: "guardian", subjectKind: "adult" },
      { authorityKind: "adultRepresentative", subjectKind: "minor" }]) {
      f.state.record = { ...f.record, ...patch }; assert.equal((await f.read()).ok, false);
    }
  } finally { await f.g.close(); }
  const both = await fixture({ allowedAuthorities: ["guardian", "adultRepresentative"] });
  try {
    await both.g.issue(); both.state.record = { ...both.record, authorityKind: "adultRepresentative", subjectKind: "adult" };
    assert.equal((await both.read()).ok, true);
    // This is process + explicit record authority, not native age/subject
    // selection or a patient proof; those remain separate serving checks.
    assert.deepEqual(both.g.f.provider, []);
  } finally { await both.g.close(); }
});

test("authority approver requires the current exact clinic administrator membership", async () => {
  const f = await fixture();
  try {
    await f.g.issue();
    for (const member of [undefined, { ...f.g.f.account, actor: { ...f.g.f.account.actor, role: "staff" as const } },
      { ...f.g.f.account, actor: { ...f.g.f.account.actor, actorRef: "other" } },
      { ...f.g.f.account, actor: { ...f.g.f.account.actor, scope: { ...f.g.f.scope, clinicId: "other" } } }]) {
      f.state.member = member; assert.equal((await f.read()).ok, false);
    }
  } finally { await f.g.close(); }
});

test("authority withdrawal rotation and shared-object mutation during approval I/O defeat the result", async () => {
  const f = await fixture();
  try {
    await f.g.issue();
    for (const patch of [{ enabled: false }, { authorityVersion: "rotated" }, { subjectPatientId: "999" }, { revision: "changed" }]) {
      const shared = { ...f.record }; f.state.record = shared;
      const next = f.calls.members + 1; f.state.beforeMember = n => { if (n === next) Object.assign(shared, patch); };
      assert.equal((await f.read()).ok, false);
    }
  } finally { await f.g.close(); }
});

test("withdrawal during final membership read and membership rotation are not late approvals", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); f.state.beforeMember = n => { if (n === 2) f.state.record = { ...f.record, enabled: false }; };
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.records, 3);
    f.state.record = f.record; const first = f.calls.members + 1;
    f.state.beforeMember = n => { if (n === first + 1) f.state.member = { ...f.g.f.account, membershipVersion: "rotated-member" }; };
    assert.equal((await f.read()).ok, false);
  } finally { await f.g.close(); }
});

test("each logical authority read records approving membership identity for later selection comparison", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); const first = await f.read(); assert.ok(first.ok); if (!first.ok) return;
    f.state.member = { ...f.g.f.account, membershipVersion: "new-current-member" };
    const second = await f.read(); assert.ok(second.ok); if (!second.ok) return;
    assert.notEqual(second.value.approvalMembershipFingerprint, first.value.approvalMembershipFingerprint);
  } finally { await f.g.close(); }
});

test("identity record or process withdrawal during authority lookup defeats previously verified possession", async () => {
  for (const kind of ["identity", "process", "close"] as const) {
    const f = await fixture();
    try {
      await f.g.issue(); f.state.beforeRead = async n => {
        if (n !== 1) return;
        if (kind === "identity") f.g.state.record = { ...f.g.state.record, recordVersion: "withdrawn" };
        if (kind === "process") await f.g.replaceApproval({ enabled: false });
        if (kind === "close") f.g.session.dispose();
      };
      assert.equal((await f.read()).ok, false); assert.deepEqual(f.g.f.provider, []);
    } finally { await f.g.close(); }
  }
});

test("authority results cannot survive call end or expiry during the final clinic source read", async () => {
  for (const kind of ["end", "expiry"] as const) {
    const f = await fixture();
    try {
      await f.g.issue(); f.state.beforeRead = async n => {
        if (n !== 3) return;
        if (kind === "end") assert.ok((await f.g.f.runtime.endCall(f.g.f.callId, f.g.f.sessionId, f.config.clock())).ok);
        else f.g.f.setTime("2026-10-04T06:01:00.000Z");
      };
      assert.equal((await f.read()).ok, false);
    } finally { await f.g.close(); }
  }
});

test("non-cooperative authority lookup is bounded by cancellation without late patient reads", async () => {
  const f = await fixture(); let release: () => void = () => undefined;
  try {
    await f.g.issue(); let entered: () => void = () => undefined;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforeRead = async () => { entered(); await resume; };
    const controller = new AbortController(), pending = f.reader.read(identity, "appointments.book", "identify", controller.signal);
    await held; controller.abort(); assert.equal((await pending).ok, false); release();
    await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(f.g.f.provider, []);
  } finally { release(); await f.g.close(); }
});

test("authority source receivers are captured and cannot mutate bound actor or private input", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); const source = { record: f.record, async read(query: Parameters<ClinicGuardianPatientAuthorityRecords["read"]>[0]) {
      (query.guardian as { recordVersion: string }).recordVersion = "forged";
      (query.identity as { firstName: string }).firstName = "forged"; return ok(this.record);
    } };
    const reader = new GuardianPatientAuthority({ ...f.config, records: source }); source.read = async () => { throw new Error("late-replaced-source"); };
    assert.equal((await reader.read(identity, "appointments.book", "identify", new AbortController().signal)).ok, true);
    assert.equal(identity.firstName, "PrivateChild");
  } finally { await f.g.close(); }
});

test("guardian authority rejects foreign physical budgets call bindings and malformed private identity before discovery", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ budget: new ClinikoReadBudget(180) }, { sessionId: "foreign" }, { callId: "foreign" },
      { credentialFingerprint: clinikoCredentialFingerprint("foreign-au5") }, { actor: f.g.f.session as never }, { policy: f.g.f.policy as never }])
      assert.throws(() => new GuardianPatientAuthority({ ...f.config, ...patch }), /invalid guardian patient authority/);
    await f.g.issue();
    for (const value of [{ ...identity, dateOfBirth: "2017-02-30" }, { ...identity, firstName: "\nprivate" }, { ...identity, extra: "unapproved" }])
      assert.equal((await f.reader.read(value, "appointments.book", "identify", new AbortController().signal)).ok, false);
    assert.equal(f.calls.records, 0);
  } finally { await f.g.close(); }
});

test("unknown authority callbacks remain unknown while concrete cost declarations include all repeated work", async () => {
  const unknown = await fixture();
  try { assert.equal(unknown.reader.nativeRequestCostCeiling(unknown.g.binding), undefined); }
  finally { await unknown.g.close(); }
  const known = await fixture({ declaredCosts: true });
  try {
    assert.equal(known.reader.nativeRequestCostCeiling(known.g.binding), 10); // 2 actor contacts + 3*2 source + 2*1 membership.
    assert.equal(known.reader.ownershipNativeRequestCostCeiling(known.g.binding), 8);
    assert.equal(known.reader.nativeRequestCostCeiling({ ...known.g.binding, budget: new ClinikoReadBudget(180) }), undefined);
    assert.equal(known.reader.nativeRequestCostCeiling({ ...known.g.binding, credentialFingerprint: clinikoCredentialFingerprint("foreign-au5") }), undefined);
  } finally { await known.g.close(); }
});

test("non-disclosing authority checks require this reader's immutable issued snapshot and recheck source without native patient data", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); const found = await f.read(); assert.ok(found.ok); if (!found.ok) return;
    const snapshot = found.value, signal = new AbortController().signal, native = f.g.native.length;
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.guardian) && Object.isFrozen(snapshot.guardian.scope) &&
      Object.isFrozen(snapshot.record) && Object.isFrozen(snapshot.record.purposes) && Object.isFrozen(snapshot.record.scope));
    assert.equal(await f.reader.ownsCurrentAuthorization(structuredClone(snapshot), identity, "channel", signal), false);
    assert.equal(await f.reader.ownsCurrentAuthorization(snapshot, identity, "channel", signal), true);
    assert.equal(f.g.native.length, native);
    f.state.record = { ...f.record, authorityVersion: "withdrawn" };
    assert.equal(await f.reader.ownsCurrentAuthorization(snapshot, identity, "operation", signal), false);
    assert.equal(f.g.native.length, native);
    const another = new GuardianPatientAuthority(f.config);
    assert.equal(await another.ownsCurrentAuthorization(snapshot, identity, "channel", signal), false);
  } finally { await f.g.close(); }
});

test("repeated protected authority reads use one fresh native guardian channel check and never accept a withdrawn identity or changed channel", async () => {
  for (const fault of ["identity", "channel"] as const) {
    const f = await fixture();
    try {
      await f.g.issue(); assert.equal((await f.read()).ok, true);
      let before = f.g.native.length; assert.equal((await f.read()).ok, true); assert.equal(f.g.native.length - before, 1);
      before = f.g.native.length;
      if (fault === "identity") f.g.state.record = { ...f.g.state.record, recordVersion: "withdrawn-after-issued-approval" };
      else f.g.state.email = "changed-after-issued-approval@example.test";
      assert.equal((await f.read()).ok, false); assert.ok(f.g.native.length - before <= 1); assert.deepEqual(f.g.f.provider, []);
    } finally { await f.g.close(); }
  }
});

test("disposing guardian authority releases issued routing capability without closing the independent actor", async () => {
  const f = await fixture();
  try {
    await f.g.issue(); const found = await f.read(); assert.ok(found.ok); if (!found.ok) return;
    const reads = f.calls.records, native = f.g.native.length;
    f.reader.dispose();
    assert.equal(await f.reader.ownsCurrentAuthorization(found.value, identity, "channel", new AbortController().signal), false);
    assert.equal((await f.read()).ok, false); assert.equal(f.calls.records, reads); assert.equal(f.g.native.length, native);
    assert.equal(f.reader.matchesContext(f.config), false); assert.equal(f.reader.nativeRequestCostCeiling(f.g.binding), undefined);
    assert.ok(await f.g.session.verifiedGuardian("appointments.book"));
  } finally { await f.g.close(); }
});
