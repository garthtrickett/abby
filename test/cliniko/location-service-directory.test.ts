import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoLocationServiceDirectory } from "../../src/standalone/cliniko-location-service-directory.ts";
import { locationServiceFixture } from "../support/location-service-catalogue.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-352 location directory exposes approved public variants only and changes version with catalogue revision", async () => {
  const f = await locationServiceFixture();
  try {
    const directory = new ClinikoLocationServiceDirectory(f.routingHost("synthetic-account"), f.sources);
    const before = resultValue(await directory.identifyCall("synthetic-account", f.north.inbound.dialedNumber));
    assert.equal(before.candidateServices?.length, 2);
    assert.equal(before.candidateServices![1]!.services.length, 1);
    assert.ok(before.candidateServices!.every(location => location.services.every(service => Object.keys(service).sort().join(",") === "durationMinutes,name,visitKind")));
    await f.north.replaceServices({ revision: "updated-public-services" });
    const after = resultValue(await directory.identifyCall("synthetic-account", f.north.inbound.dialedNumber));
    assert.notEqual(after.routeVersion, before.routeVersion);
    assert.equal(f.north.allTraffic.length + f.south.allTraffic.length, 0);
  } finally { await f.close(); }
});

for (const mode of ["revocation", "membership", "name", "duplicate"] as const) test(`E2E-352 location directory rejects ${mode} without broadening location authority`, async () => {
  const f = await locationServiceFixture();
  try {
    if (mode === "revocation") await f.south.replaceServices({ enabled: false });
    if (mode === "membership") await f.south.replaceAccount([]);
    if (mode === "name") await f.south.replaceServices({ locationName: "Other Clinic" });
    const sources = mode === "duplicate" ? [...f.sources, f.sources[1]!] : f.sources;
    const directory = new ClinikoLocationServiceDirectory(f.routingHost("synthetic-account"), sources);
    const found = await directory.identifyCall("synthetic-account", f.north.inbound.dialedNumber);
    assert.deepEqual(found, { ok: false, error: { kind: "unavailable" } });
    assert.equal(f.north.allTraffic.length + f.south.allTraffic.length, 0);
  } finally { await f.close(); }
});
