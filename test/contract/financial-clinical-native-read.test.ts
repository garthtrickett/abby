import assert from "node:assert/strict";
import test from "node:test";
import { financialClinicalNativeRead } from "../../src/standalone/financial-clinical-native-read.ts";
const scope = { tenantId: "t", clinicId: "c", locationId: "l" }, start = "2026-11-02T08:00:00.000Z";
function fixture() {
  const stop = new AbortController(); let now = start, allowed = true, calls = 0, during = () => {};
  const capability = financialClinicalNativeRead({ scope, patientId: "21", signal: stop.signal, clock: () => now,
    current: async () => { calls++; during(); return allowed; } });
  const read = (s = scope, ref = capability.reference, at = now) => capability.proof.verifyPatient(s, ref, at, stop.signal);
  return { ...capability, read, stop, time: (v: string) => { now = v; }, deny: () => { allowed = false; },
    during: (fn: () => void) => { during = fn; }, get calls() { return calls; } };
}
test("financial read capability binds exact scope/reference/subject without receiving caller verification", async () => {
  const f = fixture(); try {
    const read = await f.read(); assert.ok(read.ok); assert.equal(read.value.patientRef, "21");
    assert.equal(read.value.verificationRef, f.reference); assert.equal(f.calls, 1);
    assert.equal((await f.read({ ...scope, locationId: "other" })).ok, false);
    assert.equal((await f.read(scope, f.reference + "other")).ok, false); assert.equal(f.calls, 1);
  } finally { f.stop.abort(); }
});
for (const at of ["invalid", "2026-11-02T07:59:59.999Z", "2026-11-02T08:00:30.001Z"])
  test(`financial read capability refuses invalid/backwards/expired own clock ${at}`, async () => {
    const f = fixture(); try { f.time(at); assert.equal((await f.read()).ok, false); assert.equal(f.calls, 0); }
    finally { f.stop.abort(); }
  });
test("financial read capability refuses stale query time, current denial and an ended operation", async () => {
  const f = fixture(); try {
    assert.equal((await f.read(scope, f.reference, "2026-11-02T07:59:29.000Z")).ok, false);
    f.deny(); assert.equal((await f.read()).ok, false); f.stop.abort(); assert.equal((await f.read()).ok, false);
  } finally { f.stop.abort(); }
});
test("financial read authority cannot outlive a clock change or abort during its current grant", async () => {
  for (const change of ["clock", "abort"] as const) {
    const f = fixture(); try {
      f.during(() => change === "clock" ? f.time("2026-11-02T08:00:31.000Z") : f.stop.abort());
      assert.equal((await f.read()).ok, false);
    } finally { f.stop.abort(); }
  }
});
