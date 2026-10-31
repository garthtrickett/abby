import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoGuardianSelection } from "../../src/standalone/cliniko-guardian-selection.ts";
import { guardianSelectionFixture } from "../support/guardian-selection.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("a non-patient actor obtains only the selected patient's separate registered-email proof", async () => {
  const f = await guardianSelectionFixture();
  try {
    assert.equal((await f.select()).ok, false); assert.equal(f.requests.length, 0);
    const guardian = await f.g.issue(), verifier = await f.verifySubject(), patient = await verifier.verifiedSubject("appointments.book");
    assert.equal(patient?.patientRef, f.subjectId); assert.ok(patient); assert.notEqual(patient.verificationRef, guardian.verificationRef);
    assert.equal(verifier.usesSelfRegisteredContact(), false); assert.equal("patientRef" in guardian, false);
    assert.equal(f.mail[0]?.email, "private-selected-patient@example.test"); assert.notEqual(f.mail[0]?.email, f.g.mail[0]?.email);
    assert.equal((await f.select()).ok, false); assert.deepEqual(f.g.f.provider, []);
    const stored = JSON.stringify(await f.g.f.state());
    for (const value of [f.identity.lastName, f.identity.dateOfBirth, f.subjectId, f.mail[0]!.email, f.mail[0]!.code, f.g.mail[0]!.email, "private-patient-notes-canary"])
      assert.equal(stored.includes(value), false);
  } finally { await f.close(); }
});

test("absent or withdrawn subject authority prevents native patient reads even with verified guardian possession", async () => {
  const f = await guardianSelectionFixture();
  try {
    await f.g.issue(); f.state.authority = undefined; assert.equal((await f.select()).ok, false); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("a clinic authority record cannot substitute a different native patient name date email or active state", async () => {
  const f = await guardianSelectionFixture();
  try {
    await f.g.issue(); const original = structuredClone(f.state.patient);
    for (const patch of [{ id: "11" }, { first_name: "Other" }, { last_name: "Other" }, { date_of_birth: "2017-03-01" },
      { date_of_birth: "2017-02-30" }, { archived_at: "2026-10-04T00:00:00Z" }, { email: null }, { links: { self: "https://api.au1.cliniko.com/v1/patients/11" } }]) {
      f.state.patient = { ...original, ...patch }; assert.equal((await f.select()).ok, false); assert.equal(f.mail.length, 0);
    }
  } finally { await f.close(); }
});

test("native age determines minor guardian or explicitly approved adult representative eligibility", async () => {
  const minor = await guardianSelectionFixture();
  try { await minor.g.issue(); minor.state.patient.date_of_birth = "1982-03-05";
    assert.equal((await minor.owner.select({ ...minor.identity, dateOfBirth: "1982-03-05" }, "appointments.book", minor.g.lifetime.signal)).ok, false); }
  finally { await minor.close(); }
  const adult = await guardianSelectionFixture({ adult: true });
  try { await adult.g.issue(); assert.equal((await adult.select()).ok, true); }
  finally { await adult.close(); }
  const future = await guardianSelectionFixture();
  try { await future.g.issue(); future.state.patient.date_of_birth = "2027-01-01";
    assert.equal((await future.owner.select({ ...future.identity, dateOfBirth: "2027-01-01" }, "appointments.book", future.g.lifetime.signal)).ok, false); }
  finally { await future.close(); }
});

test("authority withdrawal during the actual native patient read defeats selection", async () => {
  const f = await guardianSelectionFixture();
  try { await f.g.issue(); f.state.afterPatient = () => { f.state.authority = undefined; };
    assert.equal((await f.select()).ok, false); assert.equal(f.mail.length, 0); }
  finally { await f.close(); }
});

test("selected patient channel operation approval identity and guardian source remain current after proof", async () => {
  for (const fault of ["authority", "channel", "operation", "guardian", "birthDate", "callerMethod", "lease", "close"] as const) {
    const f = await guardianSelectionFixture();
    try {
      await f.g.issue(); const verifier = await f.verifySubject();
      if (fault === "authority") f.state.authority = undefined;
      if (fault === "channel") f.state.patient.email = "changed@example.test";
      if (fault === "operation") f.state.authority = { ...f.state.authority!, purposes: ["identify", "channel"] };
      if (fault === "guardian") f.g.state.email = "changed-guardian@example.test";
      if (fault === "birthDate") f.state.patient.date_of_birth = "2017-03-01";
      if (fault === "callerMethod") await f.replaceCaller({ enabled: false });
      if (fault === "lease") f.g.f.setTime("2026-10-04T06:01:00.000Z");
      if (fault === "close") f.owner.dispose();
      assert.equal(await verifier.verifiedSubject("appointments.book"), undefined, fault); assert.equal(f.mail.length, 1);
    } finally { await f.close(); }
  }
});

test("workflow patient permission remains additional to guardian possession and clinic representative authority", async () => {
  const f = await guardianSelectionFixture();
  try {
    await f.g.issue(); const selected = resultValue(await f.select());
    const verifier = resultValue(await f.owner.verifier(selected.selectionRef, f.g.lifetime.signal, {
      policy: { operation: "appointments.book", current: async scope => ({ ok: true, value: { scope, enabled: true, version: f.config.policyVersion } }) },
      permission: { allows: async () => false },
    }));
    verifier.begin(); assert.equal((await verifier.submitCode("000000")).verified, false); assert.equal(f.mail.length, 0);
    assert.equal((await f.owner.verifier(selected.selectionRef, f.g.lifetime.signal)).ok, false);
  } finally { await f.close(); }
});

test("guardian selection binds its exact authenticated call physical account budget policy and native timezone", async () => {
  const f = await guardianSelectionFixture();
  try {
    for (const config of [{ ...f.config, sessionId: "foreign" }, { ...f.config, actor: f.g.f.session as never },
      { ...f.config, inbound: { ...f.config.inbound, key: { ...f.config.inbound.key, accountRef: "foreign" } } },
      { ...f.config, receipt: { ...f.config.receipt, admission: { ...f.config.receipt.admission, dialedNumber: "+6125550111" } } as never },
      { ...f.config, cliniko: { ...f.config.cliniko, rateBudget: new ClinikoReadBudget(180) } }])
      assert.throws(() => new ClinikoGuardianSelection(config), /invalid guardian selection owner/);
    await f.g.issue(); const selected = resultValue(await f.select());
    const binding = { scope: f.g.f.scope, callId: f.g.f.callId, sessionId: f.g.f.sessionId, policyVersion: f.config.policyVersion,
      credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey), businessId: "11", timeZone: "Australia/Sydney",
      operation: "appointments.book" as const, selectionRef: selected.selectionRef, inbound: f.g.f.inbound };
    assert.equal(f.owner.matchesWorkflow(binding), true);
    for (const patch of [{ operation: "appointments.cancel" as const }, { timeZone: "UTC" }, { businessId: "12" }, { selectionRef: "forged" },
      { inbound: { ...f.g.f.inbound, presentedCallerNumber: "+61400999888" } }, { scope: { ...f.g.f.scope, locationId: "foreign" } }])
      assert.equal(f.owner.matchesWorkflow({ ...binding, ...patch }), false);
    const wrongZone = new ClinikoGuardianSelection({ ...f.config, cliniko: { ...f.config.cliniko, timeZone: "UTC" } });
    try { const before = f.requests.length; assert.equal((await wrongZone.select(f.identity, "appointments.book", f.g.lifetime.signal)).ok, false); assert.equal(f.requests.length, before); }
    finally { wrongZone.dispose(); }
  } finally { await f.close(); }
});

test("guardian cancellation bounds an uncooperative native read and late data cannot create a subject verifier", async () => {
  const f = await guardianSelectionFixture(); let release: () => void = () => undefined;
  try {
    await f.g.issue(); let entered: () => void = () => undefined;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforePatient = async () => { entered(); await resume; };
    const pending = f.select(); await held; f.owner.dispose(); assert.equal((await pending).ok, false); release();
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.mail.length, 0);
  } finally { release(); await f.close(); }
});
