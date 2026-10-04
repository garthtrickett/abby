import assert from "node:assert/strict";
import test from "node:test";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { standaloneBookingFixture } from "../support/standalone-booking.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

async function prepare(f: Awaited<ReturnType<typeof standaloneBookingFixture>>) {
  const ref = await f.verify(); assert.ok((await f.propose(ref)).ok); assert.ok((await f.confirm()).ok); return ref;
}

test("E2E-279 standalone best-effort booking uses actual email proof, played SAM affirmation, review and exact/conflict inspections", async () => {
  const f = await standaloneBookingFixture();
  try {
    const ref = await prepare(f); assert.equal(f.recalls.length, 0); assert.equal(f.posts, 0);
    assert.ok((await f.drain()).ok); assert.equal(f.recalls.length, 1); assert.equal(f.posts, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    const review = decodeClinikoReview(f.recalls[0]!.notes); assert.ok(review.ok);
    assert.equal(review.value.request.operation.kind, "book");
    assert.equal(review.value.request.patientId, verificationCanaries[2]);
    assert.deepEqual([review.value.request.operation.startsAt, review.value.request.operation.endsAt], [f.evidence.offer.startsAt, f.evidence.endsAt]);
    assert.equal(f.traffic.filter(value => value === "POST /v1/individual_appointments").length, 1);
    assert.ok(f.traffic.includes("GET /v1/individual_appointments/91")); assert.ok(f.traffic.includes("GET /v1/individual_appointments/91/conflicts"));
    assert.equal(f.claims, f.traffic.length); assert.equal((await f.discovery()).pending.length, 1);
    await f.drain(); assert.equal(f.posts, 1);
    const progress = await f.propose(ref, "second-proposal");
    for (const secret of [...verificationCanaries, ref, f.mail[0]!.code]) assert.equal(JSON.stringify(progress).includes(secret), false);
  } finally { await f.close(); }
});

test("E2E-279 a guessed/wrong-operation proof, disabled policy, absent staff declaration or unplayed affirmation cannot save review or book", async () => {
  for (const failure of ["proof", "permission", "method", "automation", "booking", "stop", "unplayed", "callEnd"] as const) {
    const f = await standaloneBookingFixture();
    try {
      if (failure === "proof") await f.propose("guessed-proof");
      else {
        const ref = await f.verify();
        if (failure === "permission") f.setPermitted(false);
        if (failure === "method") await f.replaceApproval({ enabled: false });
        if (failure === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (failure === "booking") assert.ok((await f.policies.changeBookingEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (failure === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
        if (failure === "callEnd") assert.ok((await f.runtime.endCall(f.callId, f.sessionId, verificationNow)).ok);
        const proposal = await f.propose(ref);
        if (failure === "unplayed") { assert.ok(proposal.ok); assert.equal((await f.confirm(false)).ok, false); }
      }
      await f.drain(); assert.equal(f.recalls.length, 0); assert.equal(f.posts, 0);
    } finally { await f.close(); }
  }
});

test("E2E-279 changed approved provider selection, interval, service, expiry or booking policy cannot send after confirmed review", async () => {
  for (const field of ["businessId", "practitionerId", "appointmentTypeId", "credentialFingerprint", "endsAt", "timeZone", "bookingPolicyVersion", "service", "start", "expiry", "authority"] as const) {
    const f = await standaloneBookingFixture();
    try {
      await prepare(f);
      f.setOnRecall(async () => {
        if (field === "service") f.setEvidence({ offer: { ...f.evidence.offer, serviceRef: "different-service" } });
        else if (field === "start") f.setEvidence({ offer: { ...f.evidence.offer, startsAt: "2026-10-08T05:00:00.000Z" } });
        else if (field === "expiry") f.setEvidence({ offer: { ...f.evidence.offer, expiresAt: verificationNow } });
        else if (field === "authority") f.denyAuthority();
        else f.setEvidence({ [field]: field === "endsAt" ? "2026-10-08T04:45:00.000Z" : field === "timeZone" ? "Asia/Jakarta" : "changed" });
      });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.posts, 0);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-279 late caller permission, method/member approval, settings, lease, write-stop or disconnect revokes clinical sending", async () => {
  for (const failure of ["permission", "method", "member", "automation", "booking", "stop", "lease", "close"] as const) {
    const f = await standaloneBookingFixture();
    try {
      await prepare(f); f.setOnRecall(async () => {
        if (failure === "permission") f.setPermitted(false);
        if (failure === "method") await f.replaceApproval({ revision: "changed" });
        if (failure === "member") await f.replaceAccount({ membershipVersion: "changed" });
        if (failure === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (failure === "booking") assert.ok((await f.policies.changeBookingEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (failure === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
        if (failure === "lease") f.setTime("2026-10-04T06:01:00.000Z");
        if (failure === "close") f.host.dispose();
      });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.posts, 0);
    } finally { await f.close(); }
  }
});

test("E2E-279 lost review or booking responses keep pending provider review, never replay and never later claim exact commit", async () => {
  for (const lostRecall of [true, false]) {
    const f = await standaloneBookingFixture({ lostRecall, lostBooking: !lostRecall });
    try {
      await prepare(f); await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.posts, lostRecall ? 0 : 1);
      const action = Object.values((await f.state()).actions)[0]!; assert.notEqual(action.status, "committed");
      assert.deepEqual(await f.host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
      assert.equal((await f.discovery()).pending.length, 1); await f.drain(); assert.equal(f.posts, lostRecall ? 0 : 1);
    } finally { await f.close(); }
  }
});

test("E2E-279 inconsistent/unreadable created target and conflicts stay unresolved without automatic cancellation or later upgrade", async () => {
  for (const failure of ["duration", "patient", "marker", "cancelled", "unavailable", "malformed", "conflict", "conflictMalformed", "conflictUnavailable"] as const) {
    const f = await standaloneBookingFixture();
    try {
      await prepare(f);
      if (failure === "conflict") f.setConflict("present");
      else if (failure === "conflictMalformed") f.setConflict("malformed");
      else if (failure === "conflictUnavailable") f.setConflict("unavailable"); else f.setInspection(failure);
      await f.drain(); assert.equal(f.posts, 1); assert.equal(f.recalls.length, 1);
      const action = Object.values((await f.state()).actions)[0]!; assert.notEqual(action.status, "committed");
      f.setInspection("exact"); f.setConflict("clear");
      assert.deepEqual(await f.host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
      assert.equal(f.traffic.some(value => value.startsWith("PATCH ") || value.startsWith("DELETE ")), false);
    } finally { await f.close(); }
  }
});

test("E2E-279 permission loss while the clinical POST is in flight prevents protected inspections and success disclosure", async () => {
  const f = await standaloneBookingFixture();
  try {
    await prepare(f); f.setOnBooking(async () => { f.setPermitted(false); }); await f.drain(); assert.equal(f.posts, 1);
    assert.equal(f.traffic.includes("GET /v1/individual_appointments/91"), false);
    assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});

test("E2E-279 read/cancellation-only proof and unproven staff declarations cannot grant booking authority", async () => {
  for (const options of [{ operation: "appointments.read" as const }, { operation: "appointments.cancel" as const }, { staffWorkEnabled: false }]) {
    const f = await standaloneBookingFixture(options);
    try {
      const ref = await f.verify(); await f.propose(ref); await f.drain();
      assert.equal(f.recalls.length, 0); assert.equal(f.posts, 0); assert.deepEqual(f.sourceQueries, []);
    } finally { await f.close(); }
  }
});

test("E2E-279 opaque issued proof references may begin with either base64url punctuation character", async () => {
  for (const prefix of ["-", "_"]) {
    const f = await standaloneBookingFixture();
    try {
      const originalRef = await f.verify(), alias = prefix + originalRef.slice(1);
      const verifyOperation = f.session.proof.verifyOperation.bind(f.session.proof);
      // Adapt only the test issuer's opaque representation; current contact, permission and operation checks stay real.
      f.session.proof.verifyOperation = async (scope, ref, operation, now) => {
        const value = await verifyOperation(scope, ref === alias ? originalRef : ref, operation, now);
        return value.ok ? { ok: true, value: { ...value.value, verificationRef: alias } } : value;
      };
      assert.ok((await f.propose(alias)).ok); assert.ok((await f.confirm()).ok); await f.drain();
      assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-279 foreign caller/clinic/session/policy/offer evidence and invalid intervals cannot prepare a booking", async () => {
  for (const kind of ["scope", "call", "session", "policy", "patient", "offer", "contract", "calendar", "longDuration"] as const) {
    const f = await standaloneBookingFixture();
    try {
      const ref = await f.verify();
      if (kind === "scope") f.setEvidence({ scope: { ...f.scope, locationId: "foreign" } });
      if (kind === "call") f.setEvidence({ callId: "foreign-call" });
      if (kind === "session") f.setEvidence({ sessionId: "foreign-session" });
      if (kind === "policy") f.setEvidence({ policyVersion: "foreign-policy" });
      if (kind === "patient") f.setEvidence({ patientId: "43" });
      if (kind === "offer") f.setEvidence({ offer: { ...f.evidence.offer, offerRef: "foreign-offer" } });
      if (kind === "contract") f.setEvidence({ contract: "atomic" as "bestEffort" });
      if (kind === "calendar") f.setEvidence({ endsAt: "2026-02-30T04:30:00.000Z" });
      if (kind === "longDuration") f.setEvidence({ endsAt: "2026-10-09T04:30:00.000Z" });
      await f.propose(ref); await f.drain(); assert.deepEqual((await f.state()).actions, {}); assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-279 close during held offer or post-send conflict work cannot create a late action or confirm a late clear result", async () => {
  for (const stage of ["offer", "conflict"] as const) {
    const f = await standaloneBookingFixture(); let release: () => void = () => undefined, entered: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    try {
      const ref = await f.verify();
      if (stage === "offer") {
        const original = f.authority.resolve.bind(f.authority);
        f.authority.resolve = async query => { entered(); await new Promise<void>(resolve => { release = resolve; }); return original(query); };
        const pending = f.propose(ref); await ready; f.host.dispose(); await pending;
        release(); await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual((await f.state()).actions, {}); assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0);
      } else {
        assert.ok((await f.propose(ref)).ok); assert.ok((await f.confirm()).ok);
        f.setOnConflict(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
        const pending = f.drain(); await ready; f.host.dispose(); await pending;
        release(); await new Promise<void>(resolve => setImmediate(resolve));
        const action = Object.values((await f.state()).actions)[0]!;
        assert.notEqual(action.status, "committed"); assert.equal(f.posts, 1);
        assert.deepEqual(await f.host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
      }
    } finally { release(); await f.close(); }
  }
});

test("E2E-279 evidence callbacks cannot mutate query bindings or retarget a proposal during later policy waits", async () => {
  const f = await standaloneBookingFixture();
  try {
    const selected = structuredClone(f.evidence); let returned = false;
    f.authority.resolve = async query => {
      assert.equal(Reflect.set(query, "patientId", "43"), false);
      assert.equal(Reflect.set(query.scope, "locationId", "foreign"), false);
      returned = true; return { ok: true, value: selected };
    };
    const originalRead = f.policies.read.bind(f.policies);
    f.policies.read = async scope => {
      const found = await originalRead(scope);
      if (returned) Reflect.set(selected, "offer", { ...selected.offer, startsAt: "2026-10-08T05:00:00.000Z" });
      return found;
    };
    assert.ok((await f.propose(await f.verify())).ok);
    const action = Object.values((await f.state()).actions)[0]!;
    assert.equal(action.mutation.request.kind, "book");
    if (action.mutation.request.kind === "book") assert.equal(action.mutation.request.offer.startsAt, "2026-10-08T04:00:00.000Z");
    assert.ok((await f.confirm()).ok); await f.drain(); assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});
