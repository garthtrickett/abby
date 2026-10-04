import assert from "node:assert/strict";
import test from "node:test";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

test("E2E-287 concrete protected old target, current fee and bound available destination reach played SAM review and one exact move", async () => {
  const f = await reschedulingAuthorityFixture();
  try {
    assert.equal((await f.source.list(f.scope, "guessed", verificationNow, "2026-10-09T06:00:00.000Z", verificationNow)).ok, false);
    assert.equal((await f.source.listOffers(f.scope, "guessed", "2026-10-08", "2026-10-08", verificationNow)).ok, false);
    assert.equal(f.traffic.length, 0);
    const proof = await f.verify(), selected = await f.select(proof);
    assert.match(selected.targetRef, /^[A-Za-z0-9_-]{32}$/); assert.match(selected.offerRef, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await f.source.resolve({ ...f.query(proof, selected.targetRef, selected.offerRef), targetRef: "91" })).ok, false);
    assert.equal((await f.source.resolve({ ...f.query(proof, selected.targetRef, selected.offerRef), offerRef: "guessed" })).ok, false);
    const proposed = await f.proposeSelection(proof, selected); assert.ok(proposed.ok);
    const action = Object.values((await f.state()).actions)[0]!;
    assert.equal(action.mutation.request.kind, "reschedule");
    if (action.mutation.request.kind === "reschedule") {
      assert.equal(action.mutation.request.terms.approvedText, f.approval.standardTerms.approvedText);
      assert.equal(action.mutation.request.offer.presentation?.practitionerName, "Demo Practitioner");
    }
    await f.confirm(); await f.drain();
    assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    for (const value of [...verificationCanaries.slice(0, 2), f.mail[0]!.code]) assert.equal(JSON.stringify(proposed).includes(value), false);
    await f.drain(); assert.equal(f.patches, 1);
  } finally { await f.close(); }
});

test("E2E-287 protected move selections cannot cross operation, call, proof, patient, scope or relisting", async () => {
  const f = await reschedulingAuthorityFixture(), other = await reschedulingAuthorityFixture({ scope: f.scope });
  try {
    const proof = await f.verify(), selected = await f.select(proof), query = f.query(proof, selected.targetRef, selected.offerRef);
    for (const patch of [{ callId: "other" }, { sessionId: "other" }, { verificationRef: "other" }, { patientId: "43" },
      { policyVersion: "other" }, { scope: { ...f.scope, locationId: "other" } }]) assert.equal((await f.source.resolve({ ...query, ...patch })).ok, false);
    assert.equal((await other.source.resolve({ ...query, callId: other.callId, sessionId: other.sessionId })).ok, false);
    assert.equal((await f.source.resolve({ ...query, kind: "cancel" })).ok, false);
    await f.select(proof); assert.equal((await f.source.resolve(query)).ok, false);
    f.source.dispose(); assert.equal((await f.source.resolve(query)).ok, false);
    assert.equal(f.patches + other.patches, 0);
  } finally { await f.close(); await other.close(); }
  for (const operation of ["appointments.read", "appointments.book", "appointments.cancel"] as const) {
    const a = await reschedulingAuthorityFixture({ operation });
    try { const proof = await a.verify(), before = a.traffic.length;
      assert.equal((await a.source.list(a.scope, proof, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow)).ok, false);
      assert.equal((await a.source.listOffers(a.scope, proof, "2026-10-08", "2026-10-08", verificationNow)).ok, false);
      assert.equal(a.traffic.length, before, "wrong-operation proof permits no protected HTTP");
    } finally { await a.close(); }
  }
});

test("E2E-287 fresh source/provider eligibility, relationships, duration, names and availability are required at commit", async () => {
  for (const change of ["type", "practitioner", "duration", "relationship", "inactive", "businessOnline", "businessArchive", "zone", "name", "unavailable", "noTime"] as const) {
    const f = await reschedulingAuthorityFixture();
    try {
      const proof = await f.verify(), selected = await f.select(proof); assert.ok((await f.proposeSelection(proof, selected)).ok); await f.confirm();
      f.setOnRecall(async () => { if (change === "noTime") f.setStarts([]); else f.setFailure(change); });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0, change);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-287/E2E-288 current fee, destination approval, administrator, permission and fixed expiry are rechecked after review", async () => {
  for (const change of ["fee", "feeDisabled", "destination", "member", "permission", "expired", "stop", "close"] as const) {
    const f = await reschedulingAuthorityFixture();
    try {
      const proof = await f.verify(), selected = await f.select(proof); assert.ok((await f.proposeSelection(proof, selected)).ok); await f.confirm();
      f.setOnRecall(async () => {
        if (change === "fee") await f.replacePolicy({ standardTerms: { version: "changed", approvedText: "A fee applies." } });
        if (change === "feeDisabled") await f.replacePolicy({ enabled: false });
        if (change === "destination") await f.replaceDestination({ minNoticeMinutes: 120 });
        if (change === "member") await f.replaceAccount([{ ...f.account, membershipVersion: "revoked" }]);
        if (change === "permission") f.setPermitted(false);
        if (change === "expired") f.setTime("2026-10-04T06:02:00.000Z");
        if (change === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
        if (change === "close") f.source.dispose();
      });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0, change);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-287 caller selection cannot move to its current time or change the source duration", async () => {
  for (const change of ["sameTime", "duration"] as const) {
    const f = await reschedulingAuthorityFixture();
    try {
      const proof = await f.verify(); if (change === "sameTime") f.setStarts(["2026-10-08T04:00:00.000Z"]);
      const selected = await f.select(proof); if (change === "duration") f.setInspection("duration");
      assert.equal((await f.source.resolve(f.query(proof, selected.targetRef, selected.offerRef))).ok, false);
      await f.proposeSelection(proof, selected); assert.deepEqual(Object.keys((await f.state()).actions), []);
      assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-287 held destination consumer deadline or close cannot publish late private selection authority", async () => {
  for (const close of [false, true]) {
    let release: () => void = () => {}, entered: () => void = () => {};
    const f = await reschedulingAuthorityFixture(), controller = new AbortController();
    const held = new Promise<void>(resolve => { entered = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const proof = await f.verify(), selected = await f.select(proof);
      f.setOnTimes(async () => { entered(); if (!close) timer = setTimeout(() => controller.abort(), 100);
        await new Promise<void>(resolve => { release = resolve; }); });
      const pending = f.source.resolve({ ...f.query(proof, selected.targetRef, selected.offerRef), signal: controller.signal });
      await held; if (close) f.source.dispose(); assert.equal((await pending).ok, false);
      release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.patches, 0);
    } finally { if (timer) clearTimeout(timer); release(); await f.close(); }
  }
});

test("E2E-287 held shared provider budget respects abort and cannot perform late protected HTTP", async () => {
  let held = false, release: () => void = () => {}, entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const budget = { claim: async () => { if (held) { entered(); await new Promise<void>(resolve => { release = resolve; }); } return null; },
    observe429: async () => ({ kind: "rateLimited" as const }) };
  const f = await reschedulingAuthorityFixture({ rateBudget: budget }), controller = new AbortController();
  try {
    const proof = await f.verify(), selected = await f.select(proof), before = f.traffic.length;
    held = true; const pending = f.source.resolve({ ...f.query(proof, selected.targetRef, selected.offerRef), signal: controller.signal });
    await waiting; controller.abort(); assert.equal((await pending).ok, false);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.traffic.length, before, "late budget result cannot start provider IO"); assert.equal(f.patches, 0);
  } finally { release(); await f.close(); }
});

test("E2E-287 real verifier and provider budget cannot be rebound to a foreign call/provider configuration", async () => {
  const a = await reschedulingAuthorityFixture(), b = await reschedulingAuthorityFixture({ scope: a.scope });
  try {
    for (const patch of [{ proof: b.session.proof }, { callId: "other-call" }, { sessionId: "other-session" }, { policyVersion: "other" },
      { scope: { ...a.scope, locationId: "other" } }, { businessId: "12" }, { practitionerId: "23" }, { appointmentTypeId: "34" },
      { apiKey: "other-secret-au5" }, { timeoutMs: 0 }]) {
      assert.equal(a.createSource(patch).ok, false);
    }
    // @ts-expect-error deliberate malformed runtime configuration omits the mandatory shared budget.
    assert.equal(a.createSource({ rateBudget: undefined }).ok, false);
    assert.equal(a.traffic.length + b.traffic.length, 0);
  } finally { await a.close(); await b.close(); }
});

test("E2E-287 numbered private source choice is consumed once and caller query mutation cannot retarget resolution", async () => {
  const f = await reschedulingAuthorityFixture({ multiple: true });
  let release: () => void = () => {};
  try {
    const proof = await f.verify();
    assert.ok((await f.source.list(f.scope, proof, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow)).ok);
    const chosen = await f.source.select(f.scope, proof, 1, verificationNow); assert.ok(chosen.ok);
    assert.equal((await f.source.select(f.scope, proof, 1, verificationNow)).ok, false);
    const offers = await f.source.listOffers(f.scope, proof, "2026-10-08", "2026-10-08", verificationNow); assert.ok(offers.ok);
    const targetRef = chosen.value.snapshot.appointments[0]!.appointmentRef, offerRef = offers.value.choices[0]!.offerRef;
    let entered: () => void = () => {}, held = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.setOnBusiness(async () => { if (held) { entered(); await new Promise<void>(resolve => { release = resolve; }); held = false; } });
    const query = f.query(proof, targetRef, offerRef), pending = f.source.resolve(query); await started;
    query.targetRef = "91"; query.offerRef = "guessed"; query.scope = { ...f.scope, locationId: "other" }; release();
    const resolved = await pending; assert.ok(resolved.ok); assert.equal(resolved.value.targetRef, targetRef);
    assert.equal(resolved.value.kind, "reschedule"); if (resolved.value.kind === "reschedule") assert.equal(resolved.value.offer.offerRef, offerRef);
    assert.equal(f.patches, 0);
  } finally { release(); await f.close(); }
});
