import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { ClinikoRepresentativeSelection } from "../../src/standalone/cliniko-representative-selection.ts";
import { OwnerFileRepresentativePolicy } from "../../src/standalone/owner-file-representative-policy.ts";
import { VerifiedAppointmentReadSession } from "../../src/standalone/verified-appointment-read-session.ts";
import { representativeFixture } from "../support/representative-selection.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-382 representative identity and distinct registered channel reach the actual protected Cliniko reader", async () => {
  const f = await representativeFixture();
  try {
    assert.equal((await f.select()).ok, false); assert.equal(f.requests.length, 0);
    await f.verifyActor();
    const selected = resultValue(await f.select()); assert.deepEqual(Object.keys(selected), ["selectionRef"]);
    const verifier = resultValue(await f.owner.verifier(selected.selectionRef, f.lifetime.signal));
    assert.equal(await verifier.verified(), undefined); assert.equal(f.mail.length, 0);
    verifier.begin();
    const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail[0]?.email, "subject-one-private@example.test");
    const wrongCode = f.f.mail[0]!.code === f.mail[0]!.code ? (f.mail[0]!.code === "000000" ? "999999" : "000000") : f.f.mail[0]!.code;
    assert.equal((await verifier.submitCode(wrongCode)).verified, false);
    assert.equal((await verifier.submitCode(f.mail[0]!.code)).verified, true);
    const grant = await verifier.verified(); assert.ok(grant);
    const read = resultValue(VerifiedAppointmentReadSession.fromVerification({ verification: verifier, scope: f.f.scope,
      cliniko: f.config.cliniko, fetchPort: f.config.fetchPort!, clock: f.config.clock! }));
    assert.equal((await read.appointments.list(f.f.scope, grant.verificationRef, f.config.clock!(), "2026-10-05T06:00:00.000Z", f.config.clock!())).ok, true);
    assert.equal((await read.appointments.list(f.f.scope, (await f.f.session.verified())!.verificationRef, f.config.clock!(), "2026-10-05T06:00:00.000Z", f.config.clock!())).ok, false);
    assert.equal((await f.owner.verifier(selected.selectionRef, f.lifetime.signal)).ok, false);
    assert.equal((await f.select()).ok, false);
    assert.throws(() => new ClinikoRepresentativeSelection({ ...f.config, actor: verifier }), /invalid representative owner/);
    const publicState = JSON.stringify(await f.f.state());
    for (const value of [f.identity.lastName, f.identity.dateOfBirth, ...f.mail.flatMap(row => [row.email, row.code])]) assert.equal(publicState.includes(value), false);
  } finally { await f.close(); }
});

test("E2E-382 a native family link cannot grant lookup, patient access or channel delivery", async () => {
  for (const fault of ["lookup", "authority", "legacyCaller", "operation", "budget"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor();
      if (fault === "lookup") f.setLookup(false);
      if (fault === "authority") f.authorizations.clear();
      if (fault === "budget") f.setBudget(false);
      const selected = await f.select();
      if (["lookup", "authority", "budget"].includes(fault)) {
        assert.equal(selected.ok, false); assert.equal(f.requests.some(url => url.startsWith("/v1/patients/")), false);
      } else {
        assert.ok(selected.ok);
        if (fault === "legacyCaller") await f.replaceCaller({ representatives: "deny", representativeRecipient: undefined });
        if (fault === "operation") f.setOperations(false);
        const result = await f.owner.verifier(selected.value.selectionRef, f.lifetime.signal);
        if (fault === "legacyCaller") assert.equal(result.ok, false);
        else { assert.ok(result.ok); result.value.begin(); assert.equal((await result.value.submitCode("000000")).verified, false); }
      }
      assert.equal(f.mail.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-382 incomplete, ambiguous, archived or foreign native evidence cannot select a person", async () => {
  for (const fault of ["partial", "ambiguous", "foreign", "archived", "duplicate", "drift"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor(); f.setFault(fault);
      if (fault === "ambiguous") f.authorizations.set("44", { ...f.authorizations.get("43")!, authorityRef: "other-adult" });
      assert.equal((await f.select()).ok, false); assert.equal(f.mail.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-382 withdrawal or changed private evidence fences an already verified representative", async () => {
  for (const fault of ["lookup", "authority", "version", "expiry", "email", "birthDate", "actorEmail", "membership", "source", "callerSource", "lease", "disconnect"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor(); const verifier = await f.verifySubject();
      if (fault === "lookup") f.setLookup(false);
      if (fault === "authority") f.authorizations.delete("43");
      if (fault === "version") f.authorizations.set("43", { ...f.authorizations.get("43")!, version: "2" });
      if (fault === "expiry") f.f.setTime("2026-10-04T06:02:00.000Z");
      if (fault === "email") f.patients.get("43")!.email = "changed@example.test";
      if (fault === "birthDate") f.patients.get("43")!.date_of_birth = "1983-03-05";
      if (fault === "actorEmail") f.f.setEmail("changed-actor@example.test");
      if (fault === "membership") await f.f.replaceAccount({ membershipVersion: "2" });
      if (fault === "source") await f.replaceApproval({ enabled: false });
      if (fault === "callerSource") await f.replaceCaller({ enabled: false });
      if (fault === "lease") f.f.setTime("2026-10-04T06:00:31.000Z");
      if (fault === "disconnect") f.lifetime.abort();
      assert.equal(await verifier.verified(), undefined, fault); assert.equal(f.mail.length, 1);
    } finally { await f.close(); }
  }
});

test("E2E-382 independent authority withdrawn during a native subject read prevents selection", async () => {
  const f = await representativeFixture();
  try {
    await f.verifyActor(); f.afterSubjectRead(() => f.authorizations.delete("43"));
    assert.equal((await f.select()).ok, false); assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

test("E2E-382 guardian authority must match the native age and the clinic's separately approved process", async () => {
  for (const fault of ["none", "falseAdult", "falseMinor", "guardianDenied", "futureBirth"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor();
      if (fault === "falseAdult") f.authorizations.set("44", { ...f.authorizations.get("44")!, subjectKind: "adult", authorityKind: "adultRepresentative" });
      if (fault === "falseMinor") f.authorizations.set("43", { ...f.authorizations.get("43")!, subjectKind: "minor", authorityKind: "guardian" });
      if (fault === "futureBirth") f.patients.get("44")!.date_of_birth = "2027-02-28";
      if (fault === "guardianDenied") await f.replaceApproval({ allowedAuthorities: ["adultRepresentative"] });
      const identity = { firstName: "Synthetic", lastName: "Second Person", dateOfBirth: f.patients.get("44")!.date_of_birth };
      const selected = await f.owner.select(identity, "appointments.read", f.lifetime.signal);
      if (fault !== "none") { assert.equal(selected.ok, false); assert.equal(f.mail.length, 0); continue; }
      assert.ok(selected.ok); const verifier = resultValue(await f.owner.verifier(selected.value.selectionRef, f.lifetime.signal));
      verifier.begin(); const deadline = Date.now() + 5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail[0]?.email, "subject-two-private@example.test");
      assert.equal((await verifier.submitCode(f.mail[0]!.code)).verified, true);
      assert.equal((await verifier.verifiedSubject("appointments.read"))?.patientRef, "44");
    } finally { await f.close(); }
  }
});

test("E2E-382 representative approval rejects arbitrary recipients and incomplete clinic boundaries", async () => {
  for (const patch of [{ adultAgeYears: 17 }, { adultAgeYears: 121 }, { leapDayBirthday: "feb28" }, { operations: ["unknown"] },
    { allowedAuthorities: ["guardian", "guardian"] }, { recipient: "callerProvidedEmail" }, { businessId: "12" }, { credentialFingerprint: "a".repeat(64) }]) {
    const f = await representativeFixture();
    try {
      await f.replaceApproval(patch);
      assert.equal((await OwnerFileRepresentativePolicy.capture(f.policyConfig)).ok, false);
    } finally { await f.close(); }
  }
});

test("E2E-382 selection completes native paging and rejects a changed total or exceeded bound", async () => {
  for (const fault of [undefined, "pageDrift", "oversized"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor();
      const base = "https://api.au5.cliniko.com/v1";
      const rows = Array.from({ length: 101 }, (_, index) => ({ id: String(101 + index), archived_at: null,
        updated_at: "2026-10-04T05:00:00.000Z", relation: 60,
        patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } },
        related_patient: { links: { self: `${base}/patients/${index === 0 ? "43" : String(500 + index)}` } } }));
      f.setRelations(rows); f.setFault(fault);
      assert.equal((await f.select()).ok, fault === undefined);
      if (fault !== "oversized") assert.ok(f.requests.some(url => url.includes("page=2")));
      assert.equal(f.requests.filter(url => url.startsWith("/v1/patients/")).every(url => url === "/v1/patients/43"), true);
      assert.equal(f.mail.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-382 a stale person reference cannot verify a replaced selection", async () => {
  const f = await representativeFixture();
  try {
    await f.verifyActor(); const first = resultValue(await f.select());
    const second = resultValue(await f.owner.select({ firstName: "Synthetic", lastName: "Second Person", dateOfBirth: "2014-02-28" }, "appointments.read", f.lifetime.signal));
    assert.notEqual(first.selectionRef, second.selectionRef);
    assert.equal((await f.owner.verifier(first.selectionRef, f.lifetime.signal)).ok, false);
    assert.equal((await f.owner.verifier(second.selectionRef, f.lifetime.signal)).ok, true);
    assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

test("E2E-382 actual shared Cliniko budget permits actor and subject proof plus a protected appointment read", async () => {
  const budget = new ClinikoReadBudget(200, () => Date.parse("2026-10-04T06:00:00.000Z"));
  const f = await representativeFixture(budget);
  try {
    await f.verifyActor(); const verifier = await f.verifySubject(), grant = await verifier.verified(); assert.ok(grant);
    const read = resultValue(VerifiedAppointmentReadSession.fromVerification({ verification: verifier, scope: f.f.scope,
      cliniko: { ...f.config.cliniko, rateBudget: budget }, fetchPort: f.config.fetchPort!, clock: f.config.clock! }));
    assert.equal((await read.appointments.list(f.f.scope, grant.verificationRef, f.config.clock!(), "2026-10-05T06:00:00.000Z", f.config.clock!())).ok, true);
    assert.ok(f.requests.length + f.f.provider.length <= 200);
  } finally { await f.close(); }
});

test("E2E-382 recorded caller identity disagreement independently revokes selection and delegated proof", async () => {
  for (const stage of ["beforeSelection", "afterProof"] as const) {
    const f = await representativeFixture();
    try {
      await f.verifyActor(); const verifier = stage === "afterProof" ? await f.verifySubject() : undefined;
      const now = f.config.clock!();
      resultValue(await f.f.runtime.acceptTurn({ callId: f.f.callId, sessionId: f.f.sessionId, turnId: "synthetic-denial",
        text: "That is not me.", quality: "clear", at: now }, { kind: "callerIdentityDenied", reason: "identityDisagreement" }, now));
      const requests = f.requests.length;
      assert.equal((await f.select()).ok, false);
      assert.equal(await f.f.session.verified(), undefined);
      if (verifier) assert.equal(await verifier.verified(), undefined);
      assert.equal(f.requests.length, requests, "recorded identity denial stops any new related-person native reads");
      assert.equal(f.mail.length, stage === "beforeSelection" ? 0 : 1);
    } finally { await f.close(); }
  }
});
