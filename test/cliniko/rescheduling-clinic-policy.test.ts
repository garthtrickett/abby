import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { OwnerFileReschedulingPolicy } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-288 exact public rescheduling fee schema rejects private fields, cancellation reason, malformed dates, invalid terms, bindings and unsafe file ownership", async () => {
  const f = await reschedulingAuthorityFixture();
  try {
    const config = { ...f.feePolicy.binding(), path: f.path, directory: f.directory, clock: () => verificationNow };
    for (const patch of [{ patientId: "42" }, { email: "private@example.test" }, { notes: "private note" }, { cancellationReason: 50 },
      { writeContract: "atomic" }, { notificationOwner: "abby" }, { lateNoticeHours: 0 }, { lateNoticeHours: 169 }, { lateNoticeHours: "24" },
      { maxAdvanceDays: 0 }, { maxAdvanceDays: 91 }, { businessId: "0" }, { recallTypeId: 7 }, { credentialFingerprint: "secret" },
      { timeZone: "invalid" }, { approvedAt: "2026-02-30T05:00:00.000Z" }, { effectiveUntil: verificationNow },
      { standardTerms: { version: "x", approvedText: "" } }, { standardTerms: { version: "x", approvedText: "x".repeat(501) } },
      { standardTerms: { version: "x", approvedText: "a\nb" } }, { standardTerms: { version: "x", approvedText: "fee", patientId: "42" } },
      { lateTerms: { ...f.approval.standardTerms } }, { scope: { ...f.scope, patientPhone: "+61400111222" } }]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, ...patch })); assert.equal((await OwnerFileReschedulingPolicy.capture(config)).ok, false, JSON.stringify(patch));
    }
    await f.replacePolicy({ enabled: false }); assert.equal((await OwnerFileReschedulingPolicy.capture(config)).ok, false);
    await f.replacePolicy({ enabled: true, approved: false }); assert.equal((await OwnerFileReschedulingPolicy.capture(config)).ok, false);
    await f.replacePolicy({ approved: true }); await chmod(f.path, 0o644); assert.equal((await OwnerFileReschedulingPolicy.capture(config)).ok, false);
    await chmod(f.path, 0o600); await symlink(f.path, `${f.path}.link`);
    assert.equal((await OwnerFileReschedulingPolicy.capture({ ...config, path: `${f.path}.link` })).ok, false);
  } finally { await f.close(); }
});

test("E2E-288 rescheduling notice fee and horizon use exact clinic-approved instants and expiration", async () => {
  const f = await reschedulingAuthorityFixture();
  try {
    const terms = (start: string, now = verificationNow) => OwnerFileReschedulingPolicy.termsFor(f.approval, start, now);
    assert.equal(terms("2026-10-05T06:00:00.000Z")?.version, "move-standard-1");
    assert.equal(terms("2026-10-05T05:59:59.999Z")?.version, "move-late-1");
    assert.equal(terms(verificationNow), undefined); assert.equal(terms("2027-01-02T06:00:00.001Z"), undefined);
    assert.ok(terms("2027-01-02T06:00:00.000Z")); assert.equal(terms("2026-02-30T06:00:00.000Z"), undefined);
    assert.equal(terms("2026-10-05T06:00:00Z"), undefined);
    assert.equal(terms("2026-10-05T06:00:00.000Z", f.approval.effectiveUntil), undefined);
    assert.equal(terms("2026-10-05T06:00:00.000Z", "2026-10-04T05:58:59.999Z"), undefined);
  } finally { await f.close(); }
});

test("E2E-288 fee-boundary crossing after played confirmation requires new fee consent and cannot send", async () => {
  const f = await reschedulingAuthorityFixture({ startsAt: "2026-10-05T06:00:00.000Z" });
  try {
    const proof = await f.verify(), selected = await f.select(proof); assert.ok((await f.proposeSelection(proof, selected)).ok); await f.confirm();
    f.setOnRecall(async () => { f.setTime("2026-10-04T06:00:00.001Z"); }); await f.drain();
    assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0); assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});

test("E2E-288 fee approval revoked while destination availability is pending cannot publish offers", async () => {
  const f = await reschedulingAuthorityFixture();
  try {
    const proof = await f.verify(); f.setOnTimes(async () => { await f.replacePolicy({ enabled: false }); });
    assert.equal((await f.source.listOffers(f.scope, proof, "2026-10-08", "2026-10-08", verificationNow)).ok, false);
    assert.equal(f.patches, 0);
  } finally { await f.close(); }
});
