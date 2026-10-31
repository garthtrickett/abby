// E2E-426: optional clinic-owned guardian files with independent native proofs.
import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { clinikoRequestCeiling } from "../../src/cliniko/request-cost.ts";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { ownerFileGuardianRecords } from "../../src/standalone/owner-file-guardian-records.ts";
import type { VerifiedGuardian } from "../../src/standalone/guardian-verification-session.ts";
import { guardianFileRecordFixture } from "../support/guardian-file-records.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof guardianFileRecordFixture>>;
function identityQuery(f: Fixture, signal = new AbortController().signal) {
  return { ...f.binding, normalizedPhone: f.identityDocument.entries[0]!.normalizedPhone, signal };
}
function authorityQuery(f: Fixture, signal = new AbortController().signal) {
  const record = f.identityDocument.entries[0]!.record;
  // Source-query fixture only. The concrete call-owner test below separately
  // obtains a real session proof; this shape can never activate a patient.
  const operation = f.state.authority!.operation;
  const guardian: VerifiedGuardian = { ...f.binding, kind: "verifiedGuardian", callId: "query-only-call", sessionId: "query-only-session",
    operation, contactId: record.contactId, recordRef: record.recordRef, recordVersion: record.recordVersion,
    revision: record.revision, verificationRef: "query-only-proof", expiresAt: record.effectiveUntil };
  return { ...f.binding, guardian, identity: { ...f.base.r.identity }, operation, purpose: "identify" as const, signal };
}

test("guardian file authority composes each existing administrative operation with fresh native proofs", async () => {
  for (const operation of ["book", "appointments.read", "cancel", "reschedule"] as const) {
    const f = await guardianFileRecordFixture({ operation }); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      assert.deepEqual(resultValue(await f.sources.authorities.read(authorityQuery(f))), f.state.authority);
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.beginCallerVerification(); await f.base.waitForMail(1);
      assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
      assert.equal((await owner.selectPatient(f.base.r.identity)).ok, true); assert.equal(owner.beginPatientVerification(), true);
      await f.base.waitForMail(2); assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, true); assert.equal(f.base.writes, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});

test("guardian private file sources compose native caller and separate patient verification without replacing either proof", async () => {
  const f = await guardianFileRecordFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config));
    assert.equal(owner.beginCallerVerification(), true); await f.base.waitForMail(1);
    assert.equal(f.base.mail[0]!.email, f.state.guardianEmail);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
    assert.equal((await owner.selectPatient({ ...f.base.r.identity, firstName: f.base.r.identity.firstName.toUpperCase() })).ok, true);
    assert.equal(owner.beginPatientVerification(), true); await f.base.waitForMail(2);
    assert.equal(f.base.mail[1]!.email, "subject-one-private@example.test");
    assert.equal((await f.flow.submitCode(f.base.mail[0]!.code)).verified, false);
    assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, true); assert.equal(f.base.writes, 0);
    const publicData = JSON.stringify([await f.base.f.state(), await f.flow.publicIntentContext()]);
    for (const secret of [f.base.r.identity.firstName, f.base.r.identity.lastName, f.base.r.identity.dateOfBirth,
      ...f.base.mail.flatMap(message => [message.email, message.code]), f.state.identity!.recordRef, f.state.authority!.authorityRef]) assert.equal(publicData.includes(secret), false);
  } finally { owner?.dispose(); await f.close(); }
});

test("guardian file lookup declares zero native cost only for its exact account and physical budget", async () => {
  const f = await guardianFileRecordFixture();
  try {
    const binding = { scope: f.binding.scope, credentialFingerprint: f.binding.credentialFingerprint, budget: f.sourceConfig.budget };
    for (const read of [f.sources.identities.read, f.sources.authorities.read]) {
      assert.equal(clinikoRequestCeiling(read, binding), 0);
      assert.equal(clinikoRequestCeiling(read, { ...binding, budget: new ClinikoReadBudget(180) }), undefined);
      assert.equal(clinikoRequestCeiling(read, { ...binding, credentialFingerprint: "a".repeat(64) }), undefined);
    }
    assert.equal(Object.isFrozen(f.sources) && Object.isFrozen(f.sources.identities) && Object.isFrozen(f.sources.authorities), true);
  } finally { await f.close(); }
});

test("guardian identity file refuses absent and duplicate phone indexes without native discovery or choosing an enabled row", async () => {
  const f = await guardianFileRecordFixture();
  try {
    assert.deepEqual(resultValue(await f.sources.identities.read(identityQuery(f))), f.state.identity);
    for (const entries of [[], [f.identityDocument.entries[0]!, { ...f.identityDocument.entries[0]!, record: { ...f.state.identity, enabled: false } }]]) {
      await f.writeIdentities({ ...f.identityDocument, entries }); assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false);
    }
    assert.equal(f.reads.length, 0); assert.equal(f.base.mail.length, 0);
  } finally { await f.close(); }
});

test("guardian authority file requires complete subject identity and exact current actor version and action", async () => {
  const f = await guardianFileRecordFixture();
  try {
    const query = authorityQuery(f); assert.deepEqual(resultValue(await f.sources.authorities.read(query)), f.state.authority);
    for (const patch of [{ firstName: "Other" }, { lastName: "Other" }, { dateOfBirth: "2000-01-01" }]) {
      assert.equal((await f.sources.authorities.read({ ...query, identity: { ...query.identity, ...patch } })).ok, false);
    }
    for (const patch of [{ contactId: "12345" }, { recordRef: "other" }, { recordVersion: "other" }, { revision: "other" }]) {
      assert.equal((await f.sources.authorities.read({ ...query, guardian: { ...query.guardian, ...patch } })).ok, false);
    }
    assert.equal((await f.sources.authorities.read({ ...query, operation: "appointments.cancel" })).ok, false);
    assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test("guardian file indexes reject ambiguous normalized subject grants rather than combining purposes or hiding withdrawn copies", async () => {
  const f = await guardianFileRecordFixture();
  try {
    const first = f.authorityDocument.entries[0]!;
    for (const record of [{ ...first.record, enabled: false }, { ...first.record, purposes: ["channel", "operation"] }]) {
      await f.writeAuthorities({ ...f.authorityDocument, entries: [{ ...first, record: { ...first.record, purposes: ["identify"] } },
        { ...first, identity: { ...first.identity, firstName: first.identity.firstName.toUpperCase() }, record }] });
      assert.equal((await f.sources.authorities.read(authorityQuery(f))).ok, false);
    }
  } finally { await f.close(); }
});

test("guardian file sources reread edits and deletion rather than retaining an approved snapshot", async () => {
  const f = await guardianFileRecordFixture();
  try {
    const query = identityQuery(f), original = resultValue(await f.sources.identities.read(query));
    await f.writeIdentities({ ...f.identityDocument, entries: [{ ...f.identityDocument.entries[0]!, record: { ...f.state.identity, enabled: false } }] });
    assert.deepEqual(resultValue(await f.sources.identities.read(query)), { ...f.state.identity, enabled: false });
    assert.deepEqual(original, f.state.identity); await rm(f.identityPath); assert.equal((await f.sources.identities.read(query)).ok, false);
    await rm(f.authorityPath); assert.equal((await f.sources.authorities.read(authorityQuery(f))).ok, false);
  } finally { await f.close(); }
});

test("guardian file collection and query bindings refuse cross-clinic location policy and account values", async () => {
  const f = await guardianFileRecordFixture();
  try {
    for (const patch of [{ scope: { ...f.binding.scope, locationId: "other" } }, { policyVersion: "other" }, { businessId: "22" }, { credentialFingerprint: "b".repeat(64) }]) {
      assert.equal((await f.sources.identities.read({ ...identityQuery(f), ...patch })).ok, false);
      assert.equal((await f.sources.authorities.read({ ...authorityQuery(f), ...patch })).ok, false);
      await f.writeIdentities({ ...f.identityDocument, ...patch }); assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false);
      await f.writeAuthorities({ ...f.authorityDocument, ...patch }); assert.equal((await f.sources.authorities.read(authorityQuery(f))).ok, false);
    }
  } finally { await f.close(); }
});

test("guardian file sources fail closed on unsafe filesystem objects oversized bytes and malformed collections", async () => {
  const f = await guardianFileRecordFixture();
  try {
    await chmod(f.identityPath, 0o644); assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false); await chmod(f.identityPath, 0o600);
    await rm(f.identityPath); await symlink(f.authorityPath, f.identityPath); assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false); await rm(f.identityPath);
    await writeFile(f.identityPath, JSON.stringify({ ...f.identityDocument, padding: "x".repeat(65_536) }), { mode: 0o600 });
    assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false);
    for (const value of [null, [], { ...f.identityDocument, schemaVersion: 2 }, { ...f.identityDocument, extra: true },
      { ...f.identityDocument, entries: Array.from({ length: 65 }, () => f.identityDocument.entries[0]) },
      { ...f.identityDocument, entries: [{ normalizedPhone: "+61400111222", record: null }] },
      { ...f.identityDocument, entries: [{ ...f.identityDocument.entries[0], extra: true }] }]) {
      await f.writeIdentities(value); assert.equal((await f.sources.identities.read(identityQuery(f))).ok, false);
    }
    await f.writeAuthorities({ ...f.authorityDocument, entries: [{ ...f.authorityDocument.entries[0]!, identity: { ...f.base.r.identity, lastName: "" } }] });
    assert.equal((await f.sources.authorities.read(authorityQuery(f))).ok, false);
  } finally { await f.close(); }
});

test("guardian file ports suppress results for pre-aborted and interrupted private lookups", async () => {
  const f = await guardianFileRecordFixture();
  try {
    for (const early of [true, false]) {
      const stop = new AbortController(); if (early) stop.abort();
      const identity = f.sources.identities.read(identityQuery(f, stop.signal)), authority = f.sources.authorities.read(authorityQuery(f, stop.signal));
      stop.abort(); assert.equal((await identity).ok, false); assert.equal((await authority).ok, false);
    }
    assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test("guardian file withdrawal after caller proof defeats patient selection before a second challenge", async () => {
  for (const kind of ["identity", "authority"] as const) {
    const f = await guardianFileRecordFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.beginCallerVerification(); await f.base.waitForMail(1);
      assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
      if (kind === "identity") await f.writeIdentities({ ...f.identityDocument, entries: [{ ...f.identityDocument.entries[0]!, record: { ...f.state.identity, enabled: false } }] });
      else await f.writeAuthorities({ ...f.authorityDocument, entries: [{ ...f.authorityDocument.entries[0]!, record: { ...f.state.authority, enabled: false } }] });
      assert.equal((await owner.selectPatient(f.base.r.identity)).ok, false); assert.equal(f.base.mail.length, 1); assert.equal(f.base.writes, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});

test("guardian file entries cannot replace independent administrator approval or native subject identity", async () => {
  for (const kind of ["identityAdmin", "authorityAdmin", "subject"] as const) {
    const f = await guardianFileRecordFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      if (kind === "identityAdmin") await f.writeIdentities({ ...f.identityDocument, entries: [{ ...f.identityDocument.entries[0]!, record: { ...f.state.identity, approverRef: "unknown-admin" } }] });
      if (kind === "authorityAdmin") await f.writeAuthorities({ ...f.authorityDocument, entries: [{ ...f.authorityDocument.entries[0]!, record: { ...f.state.authority, approverRef: "unknown-admin" } }] });
      if (kind === "subject") await f.writeAuthorities({ ...f.authorityDocument, entries: [{ ...f.authorityDocument.entries[0]!, record: { ...f.state.authority, subjectPatientId: f.base.r.subjectIds[1] } }] });
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.beginCallerVerification();
      if (kind === "identityAdmin") {
        assert.equal((await owner.submitCallerCode("000000")).verified, false); assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
      } else {
        await f.base.waitForMail(1); assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
        assert.equal((await owner.selectPatient(f.base.r.identity)).ok, false); assert.equal(f.base.mail.length, 1);
      }
      assert.equal(f.base.writes, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});

test("guardian file source configuration rejects relative paths and invalid account budgets", async () => {
  const f = await guardianFileRecordFixture();
  try {
    for (const patch of [{ identityPath: "guardian.json" }, { authorityPath: "guardian.json" }, { businessId: "0" }, { budget: {} as never }]) {
      assert.throws(() => ownerFileGuardianRecords({ ...f.sourceConfig, ...patch }), TypeError);
    }
  } finally { await f.close(); }
});
