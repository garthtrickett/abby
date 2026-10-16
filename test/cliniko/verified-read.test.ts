import assert from "node:assert/strict";
import test from "node:test";
import { withVerifiedClinikoRead } from "../../src/cliniko/verified-read.ts";
import type { PatientProofHost } from "../../src/core/host.ts";
import { err, ok } from "../../src/core/model.ts";

const scope = { tenantId: "read-tenant", clinicId: "read-clinic", locationId: "read-location" };
const now = "2026-10-07T10:00:00.000Z", ref = "private-operation-proof";
function fixture() {
  let calls = 0, enabled = true, patientRef = "42";
  const proof: PatientProofHost = { verifyPatient: async (s, r) => { calls++; assert.deepEqual(s, scope); assert.equal(r, ref);
    return enabled ? ok({ scope, verificationRef: ref, patientRef, expiresAt: "2026-10-08T10:00:00.000Z" }) : err({ kind: "notFound", target: "patient" }); } };
  const config = { scope, verificationRef: ref, proof, clock: () => now };
  return { config, get calls() { return calls; }, deny: () => { enabled = false; }, changeSubject: () => { patientRef = "43"; } };
}
test("E2E-410 a private compound read verifies live authority before and after, with no reusable proof outside the group", async () => {
  const f = fixture(), signal = new AbortController().signal; let retained: PatientProofHost | undefined;
  const value = await withVerifiedClinikoRead(f.config, signal, async proof => {
    retained = proof;
    for (let i = 0; i < 6; i++) { const p = await proof.verifyPatient(scope, ref, now, signal); assert.ok(p.ok); assert.equal(p.value.patientRef, "42"); }
    return "private-observation";
  });
  assert.equal(value, "private-observation"); assert.equal(f.calls, 2);
  assert.equal((await retained!.verifyPatient(scope, ref, now, signal)).ok, false);
});
for (const fault of ["revoked", "subject"] as const) test(`E2E-410 ${fault} at group closure discards every earlier private observation`, async () => {
  const f = fixture(), signal = new AbortController().signal;
  const value = await withVerifiedClinikoRead(f.config, signal, async proof => {
    assert.ok((await proof.verifyPatient(scope, ref, now, signal)).ok);
    if (fault === "revoked") f.deny(); else f.changeSubject(); return "must-not-escape";
  });
  assert.equal(value, undefined); assert.equal(f.calls, 2);
});
test("E2E-410 wrong scope/ref/time and aborted internal reads cannot use the scoped proof", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal(await withVerifiedClinikoRead(f.config, signal, async proof => {
    for (const [s, r, at] of [[{ ...scope, locationId: "foreign" }, ref, now], [scope, "other", now], [scope, ref, "2026-10-07T11:00:00.000Z"]] as const)
      assert.equal((await proof.verifyPatient(s, r, at, signal)).ok, false);
    const stopped = new AbortController(); stopped.abort(); assert.equal((await proof.verifyPatient(scope, ref, now, stopped.signal)).ok, false); return true;
  }), true);
});
test("E2E-410 denied initial authority never begins the protected group and abort closes an unresponsive source", async () => {
  const f = fixture(), signal = new AbortController().signal; f.deny(); let read = false;
  assert.equal(await withVerifiedClinikoRead(f.config, signal, async () => { read = true; return true; }), undefined); assert.equal(read, false);
  const abort = new AbortController();
  const proof: PatientProofHost = { verifyPatient: async () => { queueMicrotask(() => abort.abort()); return new Promise(() => {}); } };
  assert.equal(await withVerifiedClinikoRead({ ...f.config, proof }, abort.signal, async () => true), undefined);
});
