import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-282 exact public booking policy rejects patient fields, unsafe ranges, unavailable ownership and malformed dates or zones", async () => {
  const f = await bookingOffersFixture();
  try {
    const config = { ...f.bookingPolicy.binding(), path: f.path, directory: f.directory, clock: () => verificationNow };
    for (const patch of [{ patientId: "42" }, { email: "private@example.test" }, { notes: "patient notes" }, { writeContract: "atomic" },
      { notificationOwner: "abby" }, { serviceRef: "" }, { bookingPolicyVersion: "" }, { serviceRef: "service\nname" },
      { durationMinutes: 0 }, { durationMinutes: 481 }, { durationMinutes: "30" }, { durationMinutes: 30.5 },
      { minNoticeMinutes: 0 }, { minNoticeMinutes: 10081 }, { minNoticeMinutes: 1440, maxAdvanceDays: 1 },
      { maxAdvanceDays: 0 }, { maxAdvanceDays: 91 }, { offerTtlSeconds: 14 }, { offerTtlSeconds: 301 },
      { practitionerId: "22/extra" }, { businessId: "0" }, { appointmentTypeId: 33 }, { recallTypeId: "" },
      { credentialFingerprint: "secret" }, { timeZone: "invalid-zone" }, { approvedAt: "2026-02-30T05:00:00.000Z" },
      { effectiveUntil: verificationNow }, { scope: { ...f.scope, patientPhone: "+61400111222" } }]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, ...patch }));
      assert.equal((await OwnerFileBookingPolicy.capture(config)).ok, false, JSON.stringify(patch));
    }
    await f.replacePolicy({ enabled: false }); assert.equal((await OwnerFileBookingPolicy.capture(config)).ok, false);
    await f.replacePolicy({ enabled: true, approved: false }); assert.equal((await OwnerFileBookingPolicy.capture(config)).ok, false);
    await f.replacePolicy({ approved: true }); await chmod(f.path, 0o644); assert.equal((await OwnerFileBookingPolicy.capture(config)).ok, false);
    await chmod(f.path, 0o600); await symlink(f.path, `${f.path}.link`);
    assert.equal((await OwnerFileBookingPolicy.capture({ ...config, path: `${f.path}.link` })).ok, false);
    for (const value of ["null", "invalid", " ".repeat(8193)]) {
      await writeFile(f.path, value); assert.equal((await OwnerFileBookingPolicy.capture(config)).ok, false);
    }
  } finally { await f.close(); }
});

test("E2E-282 current admin role, membership, binding and approval expiry revoke booking policy", async () => {
  for (const change of ["role", "membership", "removed", "scope", "binding", "expired"] as const) {
    const f = await bookingOffersFixture();
    try {
      assert.ok((await f.bookingPolicy.current(f.scope)).ok);
      if (change === "role") await f.replaceAccount([{ ...f.account, actor: { ...f.account.actor, role: "staff" } }]);
      if (change === "membership") await f.replaceAccount([{ ...f.account, membershipVersion: "changed" }]);
      if (change === "removed") await f.replaceAccount([]);
      if (change === "scope") await f.replaceAccount([{ ...f.account, actor: { ...f.account.actor, scope: { ...f.scope, clinicId: "foreign" } } }]);
      if (change === "binding") await f.replacePolicy({ credentialFingerprint: "f".repeat(64) });
      if (change === "expired") f.setTime(f.approval.effectiveUntil);
      assert.equal((await f.bookingPolicy.current(f.scope)).ok, false, change);
    } finally { await f.close(); }
  }
});

test("E2E-282 notice and horizon boundaries use real canonical instants and effective approval time", async () => {
  const f = await bookingOffersFixture();
  try {
    const permits = (start: string, now = verificationNow) => OwnerFileBookingPolicy.allows(f.approval, start, now);
    assert.equal(permits("2026-10-04T06:59:59.999Z"), false); assert.equal(permits("2026-10-04T07:00:00.000Z"), true);
    assert.equal(permits("2026-11-03T06:00:00.000Z"), true); assert.equal(permits("2026-11-03T06:00:00.001Z"), false);
    assert.equal(permits("2026-02-30T07:00:00.000Z"), false); assert.equal(permits("2026-10-04T07:00:00Z"), false);
    assert.equal(permits("2026-10-08T04:00:00.000Z", f.approval.effectiveUntil), false);
    assert.equal(permits("2026-10-08T04:00:00.000Z", "2026-10-04T05:58:59.999Z"), false);
  } finally { await f.close(); }
});

test("E2E-282 approval replacement during the final protected contact refresh prevents publishing offers", async () => {
  const f = await bookingOffersFixture();
  try {
    const proof = await f.verify();
    f.setOnTimes(async () => { f.setOnContact(async () => { await f.replacePolicy({ enabled: false }); }); });
    assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
