import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { GuardianVerificationSession, guardianVerificationPrompt } from "../../src/standalone/guardian-verification-session.ts";
import { guardianVerificationFixture } from "../support/guardian-verification.ts";

test("a non-patient guardian privately verifies its approved contact without minting a patient proof or retaining private state", async () => {
  const g = await guardianVerificationFixture();
  try {
    assert.deepEqual(g.session.begin(), { prompt: guardianVerificationPrompt });
    const proof = await g.issue(); assert.equal(proof.kind, "verifiedGuardian"); assert.equal(proof.contactId, g.state.record.contactId);
    assert.equal("patientRef" in proof, false); assert.equal("registeredEmail" in proof, false); assert.equal("proof" in g.session, false);
    assert.equal(await g.f.session.verified(), undefined); assert.equal(await g.session.ownsCurrentProof("appointments.book", proof.verificationRef, new AbortController().signal), true);
    assert.equal(await g.session.verifiedGuardian("appointments.cancel"), undefined);
    await g.f.read(proof.verificationRef); assert.deepEqual(g.f.provider, []);
    assert.equal(g.mail.length, 1); assert.deepEqual(g.reservations, ["issue", "answer"]);
    const stored = JSON.stringify(await g.f.state());
    for (const value of [g.state.email, g.state.record.contactId, g.state.record.recordRef, g.mail[0]!.code, "guardian-private-note-canary"])
      assert.equal(stored.includes(value), false);
  } finally { await g.close(); }
});

test("a guardian and child may share caller-ID without treating the child's patient candidate as the actor", async () => {
  const g = await guardianVerificationFixture();
  try {
    g.f.setCandidates({ kind: "one", candidateIds: ["192837465019283746"] });
    assert.equal((await g.issue()).kind, "verifiedGuardian"); assert.deepEqual(g.f.provider, []);
    assert.ok(g.native.every(value => value.includes("/contacts/")));
  } finally { await g.close(); }
});

test("guardian process approval and permitted action remain independent of a valid identity record", async () => {
  const g = await guardianVerificationFixture();
  try {
    await g.replaceApproval({ enabled: false }); g.session.begin(); assert.deepEqual(await g.session.submitCode("000000"), { verified: false });
    assert.equal(g.mail.length, 0); assert.equal(g.native.length, 0); assert.equal(g.state.record.approved, true);
  } finally { await g.close(); }
  const other = await guardianVerificationFixture();
  try {
    const made = GuardianVerificationSession.create({ ...other.config, operation: "appointments.cancel" }); assert.ok(made.ok); if (!made.ok) return;
    try { made.value.begin(); assert.deepEqual(await made.value.submitCode("000000"), { verified: false }); assert.equal(other.native.length, 0); }
    finally { made.value.dispose(); }
  } finally { await other.close(); }
});

test("guardian proof cannot survive record withdrawal channel change or approving membership rotation", async () => {
  for (const kind of ["record", "channel", "membership"] as const) {
    const g = await guardianVerificationFixture();
    try {
      const proof = await g.issue();
      if (kind === "record") g.state.record = { ...g.state.record, recordVersion: "withdrawn-record-2" };
      if (kind === "channel") g.state.email = "changed@example.test";
      if (kind === "membership") await g.f.replaceAccount({ membershipVersion: "member-revoked" });
      assert.equal(await g.session.verifiedGuardian("appointments.book"), undefined);
      assert.equal(await g.session.ownsCurrentProof("appointments.book", proof.verificationRef, new AbortController().signal), false);
    } finally { await g.close(); }
  }
});

test("guardian process withdrawal while native channel work is pending cannot cause a late verification email", async () => {
  const g = await guardianVerificationFixture();
  try {
    g.state.beforeNative = async () => { await g.replaceApproval({ revision: "withdrawn-process-2" }); };
    g.session.begin(); assert.deepEqual(await g.session.submitCode("000000"), { verified: false });
    assert.equal(g.mail.length, 0); assert.equal(g.native.length, 1);
  } finally { await g.close(); }
});

test("guardian proof follows the actual active admission lease and current automation policy", async () => {
  for (const kind of ["end", "lease", "automation", "close"] as const) {
    const g = await guardianVerificationFixture();
    try {
      await g.issue(); const reads = g.native.length;
      if (kind === "end") assert.ok((await g.f.runtime.endCall(g.f.callId, g.f.sessionId, g.f.sessionConfig.clock())).ok);
      if (kind === "lease") g.f.setTime("2026-10-04T06:01:00.000Z");
      if (kind === "automation") {
        const policy = await g.f.policies.read(g.f.scope); assert.ok(policy.ok); if (!policy.ok) return;
        assert.ok((await g.f.policies.changeAutomationEnabled(g.f.scope, policy.value.automationVersion, false, "synthetic-admin")).ok);
      }
      if (kind === "close") g.session.dispose();
      assert.equal(await g.session.verifiedGuardian("appointments.book"), undefined); assert.equal(g.native.length, reads);
    } finally { await g.close(); }
  }
});

test("guardian verification refuses a foreign account budget admission or a patient-policy substitute", async () => {
  const g = await guardianVerificationFixture();
  try {
    const invalid: Parameters<typeof GuardianVerificationSession.create>[0][] = [
      { ...g.config, account: { ...g.config.account, budget: new ClinikoReadBudget(180) } },
      { ...g.config, account: { ...g.config.account, credentialFingerprint: clinikoCredentialFingerprint("foreign-au5") } },
      { ...g.config, inbound: { ...g.config.inbound, key: { ...g.config.inbound.key, accountRef: "foreign" } } },
      { ...g.config, receipt: { ...g.config.receipt, scope: { ...g.config.receipt.scope, locationId: "foreign" } } },
      { ...g.config, policy: g.f.policy as never },
    ];
    for (const config of invalid) assert.equal(GuardianVerificationSession.create(config).ok, false);
    assert.equal(g.mail.length, 0); assert.equal(g.native.length, 0);
  } finally { await g.close(); }
});

test("guardian call cancellation bounds non-cooperative identity lookup and prevents late mail or patient reads", async () => {
  const g = await guardianVerificationFixture(); let release: () => void = () => undefined;
  try {
    let entered: () => void = () => undefined;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    g.state.beforeRecord = async () => { entered(); await resume; };
    g.session.begin(); await held; g.lifetime.abort(); assert.deepEqual(await g.session.submitCode("000000"), { verified: false });
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(g.mail.length, 0); assert.equal(g.native.length, 0); assert.deepEqual(g.f.provider, []);
  } finally { release(); await g.close(); }
});

test("guardian proof requires the existing two-minute expiry headroom even after correct channel verification", async () => {
  const g = await guardianVerificationFixture();
  try {
    g.state.record = { ...g.state.record, effectiveUntil: new Date(Date.parse(g.config.clock!()) + 120_000).toISOString() };
    g.session.begin(); const until = Date.now() + 5000;
    while (!g.mail.length && Date.now() < until) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(g.mail.length, 1); assert.deepEqual(await g.session.submitCode(g.mail[0]!.code), { verified: false });
    assert.equal(await g.session.verifiedGuardian("appointments.book"), undefined);
  } finally { await g.close(); }
});

test("guardian proof request costs bind the real shared native budget and do not treat unknown clinic reads as free", async () => {
  const unknown = await guardianVerificationFixture();
  try { assert.equal(unknown.session.nativeRequestCostCeilings(unknown.binding), undefined); }
  finally { await unknown.close(); }
  const known = await guardianVerificationFixture({ declaredCosts: true });
  try {
    assert.deepEqual(known.session.nativeRequestCostCeilings(known.binding), { proof: 1, ownership: 0 });
    assert.equal(known.session.nativeRequestCostCeilings({ ...known.binding, budget: new ClinikoReadBudget(180) }), undefined);
    assert.equal(known.session.nativeRequestCostCeilings({ ...known.binding, credentialFingerprint: clinikoCredentialFingerprint("other-au5") }), undefined);
    const proof = await known.issue(); assert.equal(proof.kind, "verifiedGuardian");
  } finally { await known.close(); }
});
