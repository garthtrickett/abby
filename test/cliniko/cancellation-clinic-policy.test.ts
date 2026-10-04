import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { OwnerFileCancellationPolicy } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { concreteCancellationFixture } from "../support/cancellation-authority.ts";
import { cancellationNow } from "../support/standalone-cancellation.ts";

test("E2E-277 current public cancellation approval binds provider selection, method membership, terms and reason", async () => {
  for (const change of ["enabled", "approved", "business", "credential", "recallType", "timeZone", "policy", "revision", "role", "member", "removed"] as const) {
    const f = await concreteCancellationFixture();
    try {
      assert.ok((await f.feePolicy.current(f.scope)).ok);
      if (change === "enabled") await f.replacePolicy({ enabled: false });
      if (change === "approved") await f.replacePolicy({ approved: false });
      if (change === "business") await f.replacePolicy({ businessId: "12" });
      if (change === "credential") await f.replacePolicy({ credentialFingerprint: "f".repeat(64) });
      if (change === "recallType") await f.replacePolicy({ recallTypeId: "8" });
      if (change === "timeZone") await f.replacePolicy({ timeZone: "Asia/Jakarta" });
      if (change === "policy") await f.replacePolicy({ policyVersion: "changed" });
      if (change === "revision") await f.replacePolicy({ revision: "changed" });
      if (change === "role") await f.replaceAccount([{ ...f.account, actor: { ...f.account.actor, role: "staff" } }]);
      if (change === "member") await f.replaceAccount([{ ...f.account, membershipVersion: "changed" }]);
      if (change === "removed") await f.replaceAccount([]);
      assert.equal((await f.feePolicy.current(f.scope)).ok, false);
      const ref = await f.verify(); assert.equal((await f.source.list(f.scope, ref, cancellationNow, "2026-10-09T04:00:00.000Z", cancellationNow)).ok, false);
      assert.equal(f.traffic.some(value => value.includes("appointments")), false); assert.equal(f.patches, 0);
    } finally { await f.close(); }
  }
});

test("E2E-277 exact cancellation policy schema rejects unsafe defaults, expanded fields, malformed fees and weak ownership", async () => {
  const f = await concreteCancellationFixture();
  try {
    const config = { path: f.path, ...f.feePolicy.binding(), directory: f.directory, clock: () => cancellationNow };
    for (const patch of [{ patientId: "42" }, { notes: "private notes" }, { writeContract: "atomic" }, { notificationOwner: "abby" },
      { cancellationReason: 1 }, { cancellationReason: "50" }, { lateNoticeHours: 0 }, { lateNoticeHours: 169 },
      { maxAdvanceDays: 91 }, { maxAdvanceDays: 0 }, { timeZone: "invalid-zone" }, { businessId: "11/extra" },
      { standardTerms: { version: "v", approvedText: "" } }, { standardTerms: { version: "v", approvedText: "secret\nline" } },
      { standardTerms: { version: "v", approvedText: " ".repeat(2049) } }, { standardTerms: { version: "v", approvedText: "terms", patientId: "42" } },
      { standardTerms: f.record.lateTerms }, { credentialFingerprint: "not-a-fingerprint" },
      { scope: { ...f.scope, patientPhone: "+61400111222" } }, { approvedAt: "2026-02-30T04:00:00.000Z" }]) {
      await writeFile(f.path, JSON.stringify({ ...f.record, ...patch }));
      assert.deepEqual(await OwnerFileCancellationPolicy.capture(config), { ok: false, error: { kind: "cancellationPolicyUnavailable" } });
    }
    await f.replacePolicy({ enabled: false }); assert.equal((await OwnerFileCancellationPolicy.capture(config)).ok, false);
    await f.replacePolicy({ enabled: true }); await chmod(f.path, 0o644); assert.equal((await OwnerFileCancellationPolicy.capture(config)).ok, false);
    await chmod(f.path, 0o600); await symlink(f.path, `${f.path}.link`);
    assert.equal((await OwnerFileCancellationPolicy.capture({ ...config, path: `${f.path}.link` })).ok, false);
    for (const value of ["null", "invalid", " ".repeat(8193)]) {
      await writeFile(f.path, value); assert.equal((await OwnerFileCancellationPolicy.capture(config)).ok, false);
    }
  } finally { await f.close(); }
});

test("E2E-277 fee rules change at the declared notice boundary; past, distant and expired actions have no terms", async () => {
  const f = await concreteCancellationFixture();
  try {
    const policy = f.record;
    const term = (start: string, at = cancellationNow) => OwnerFileCancellationPolicy.termsFor(policy, start, at);
    assert.equal(term("2026-10-05T04:00:00.000Z")?.version, policy.standardTerms.version);
    assert.equal(term("2026-10-05T03:59:59.999Z")?.version, policy.lateTerms.version);
    assert.equal(term("2026-10-04T04:00:00.000Z"), undefined);
    assert.equal(term("2026-10-03T04:00:00.000Z"), undefined);
    assert.equal(term("2027-01-03T04:00:00.000Z"), undefined);
    assert.equal(term("invalid"), undefined);
    assert.equal(term("2026-10-08T04:00:00.000Z", policy.effectiveUntil), undefined);
    assert.deepEqual(term("2026-10-08T04:00:00.000Z"), { ...policy.standardTerms, expiresAt: policy.effectiveUntil });
  } finally { await f.close(); }
});
