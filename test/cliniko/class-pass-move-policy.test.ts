import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { classMoveFixture } from "../support/class-move.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { ClinikoClassSession } from "../../src/standalone/cliniko-class-session.ts";
import { readClassServices } from "../../src/standalone/class-service-catalogue.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const fault of ["missingContract", "missingEffect", "blankEffect", "wrongStaging", "wrongAssociation", "unknownKey", "legacyContract", "mixedMembership", "noAuthority", "selectionOnly"] as const)
  test(`E2E-410 native pass movement ${fault} cannot admit an owner or send verification`, async () => {
    const f = await classMoveFixture(true, false, { differentCase: true });
    try {
      const config = { ...f.classSessionConfig }, move = JSON.parse(await readFile(f.movePath, "utf8"));
      if (fault === "missingContract") delete move.passMovement;
      if (fault === "missingEffect") delete move.passMovement.differentCaseConsumeOne;
      if (fault === "blankEffect") move.passMovement.sameCaseUnchanged = " ";
      if (fault === "wrongStaging") move.passMovement.staging = "linkedReplacement";
      if (fault === "wrongAssociation") move.passMovement.association = "beforeOriginalCancellation";
      if (fault === "unknownKey") move.passMovement.extra = "not-approved";
      if (fault === "legacyContract") move.membership = "independentHost";
      if (fault === "mixedMembership") {
        const destination = JSON.parse(await readFile(f.destinationPath, "utf8"));
        destination.membership = "independentHost"; delete destination.caseSessions;
        await writeFile(f.destinationPath, JSON.stringify(destination));
      }
      if (fault === "noAuthority") delete config.classPassMoveAuthority;
      if (fault === "selectionOnly") config.classPassMoveAuthority = { select: config.classPassMoveAuthority!.select } as NonNullable<typeof config.classPassMoveAuthority>;
      await writeFile(f.movePath, JSON.stringify(move));
      const admitted = await ClinikoClassSession.create(config); if (admitted.ok) admitted.value.dispose();
      assert.equal(admitted.ok, false); assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { await f.close(); }
  });

for (const fault of ["none", "noAuthority", "missingContract", "mixedMembership"] as const)
  test(`E2E-410 native movement-only catalogue ${fault} exposes only a complete independently approved service`, async () => {
    const f = await classMoveCallFlowFixture(true, true, { differentCase: true });
    try {
      const c = f.classSessionConfig, service = f.flowConfig.classServices![0]!;
      if (fault === "noAuthority") delete (service.move as { passAuthority?: unknown }).passAuthority;
      if (fault === "missingContract") { const move = JSON.parse(await readFile(f.movePath, "utf8")); delete move.passMovement; await writeFile(f.movePath, JSON.stringify(move)); }
      if (fault === "mixedMembership") { const dest = JSON.parse(await readFile(f.destinationPath, "utf8")); dest.membership = "independentHost"; delete dest.caseSessions; await writeFile(f.destinationPath, JSON.stringify(dest)); }
      const result = await readClassServices({ scope: f.scope, policyVersion: c.policyVersion, businessId: c.cliniko.businessId, apiKey: c.cliniko.apiKey,
        recallTypeId: c.cliniko.recallTypeId, timeZone: c.cliniko.timeZone, directory: c.directory, clock: c.clock, services: [service] }, c.signal);
      assert.equal(result.ok, fault === "none");
      if (result.ok) {
        const items = resultValue(result).items; assert.equal(items.length, 1); assert.equal(items[0]!.public.moveAvailable, true);
        assert.equal(JSON.stringify(items[0]!.public).includes("811222333444555666"), false);
      }
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { await f.close(); }
  });
