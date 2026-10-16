// E2E-419: independently approved caller staging; source preparation alone cannot enable serving.
import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { OwnerFileClassMovePolicy } from "../../src/standalone/owner-file-class-move-policy.ts";
import type { ClassMoveApproval } from "../../src/standalone/owner-file-class-move-policy.ts";

function capture(f: Awaited<ReturnType<typeof classMoveFixture>>, original: ClassMoveApproval) {
  return OwnerFileClassMovePolicy.capture({ scope: f.scope, path: f.movePath,
    directory: f.classSessionConfig.directory, clock: f.config.clock, policyVersion: original.policyVersion,
    businessId: original.businessId, credentialFingerprint: original.credentialFingerprint,
    recallTypeId: original.recallTypeId, timeZone: original.timeZone,
    sourceServiceRef: original.sourceServiceRef, destinationServiceRef: original.destinationServiceRef });
}

test("ordinary caller staging requires its own explicit valid move-policy contract", async () => {
  const f = await classMoveFixture();
  try {
    const original = resultValue(await f.config.movePolicy.current(f.scope));
    assert.equal(original.quotaStaging, undefined);
    await f.replaceMove({ quotaStaging: { version: "caller-stages-v1" } });
    assert.equal((await f.config.movePolicy.current(f.scope)).ok, false, "a live old owner cannot adopt edited approval content");
    const current = resultValue(await capture(f, original));
    assert.deepEqual(resultValue(await current.current(f.scope)).quotaStaging, { version: "caller-stages-v1" });
    await f.replaceMove({ quotaStaging: { version: "" } });
    assert.equal((await capture(f, original)).ok, false);
  } finally { await f.close(); }
});

test("pass caller staging cannot borrow a different approved membership contract version", async () => {
  const f = await classMoveFixture(false, false, {});
  try {
    const approval = resultValue(await f.config.movePolicy.current(f.scope)); assert.ok(approval.passMovement);
    await f.replaceMove({ quotaStaging: { version: "unrelated-stage-contract" } });
    assert.equal((await capture(f, approval)).ok, false);
    await f.replaceMove({ quotaStaging: { version: approval.passMovement.version } });
    const current = resultValue(await capture(f, approval));
    assert.equal(resultValue(await current.current(f.scope)).quotaStaging?.version, approval.passMovement.version);
  } finally { await f.close(); }
});
