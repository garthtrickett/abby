import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const factsFile = "phase-2/PRODUCT_FACTS.md";
const read = (path: string): Buffer => readFileSync(resolve(root, path));
const sha256 = (path: string): string => createHash("sha256").update(read(path)).digest("hex");

test("operator product facts require reviewed content and every directly cited source fingerprint", () => {
  const manifest = JSON.parse(read("phase-2/PRODUCT_FACTS_FINGERPRINTS.json").toString("utf8")) as {
    verifiedDate: string; factsFile: string; factsSha256: string; sources: Record<string, string>;
  };
  assert.equal(manifest.factsFile, factsFile);
  assert.match(manifest.verifiedDate, /^\d{4}-\d{2}-\d{2}$/);
  const verified = new Date(`${manifest.verifiedDate}T00:00:00.000Z`);
  assert.equal(verified.toISOString().slice(0, 10), manifest.verifiedDate);
  const facts = read(factsFile).toString("utf8");
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
  }).format(verified);
  assert.ok(facts.includes(`**Verified:** ${date},`), "fact and fingerprint review dates must agree");
  assert.match(manifest.factsSha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(factsFile), manifest.factsSha256,
    "Product facts changed: review the claims and refresh their fingerprint.");

  const rows = facts.split("\n").filter(line => line.startsWith("| `"));
  assert.ok(rows.length > 0, "the operator reference must contain fact rows");
  const ids = new Set<string>(), cited = new Set<string>();
  for (const row of rows) {
    const id = /^\| `([a-z][a-zA-Z0-9.]+)` \|/.exec(row)?.[1];
    assert.ok(id && !ids.has(id), "fact IDs must be valid and unique");
    ids.add(id);
    const links = [...row.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
    assert.ok(links.length > 0, `${id} needs a source or witness`);
    for (const link of links) {
      const target = link[1]!.split("#", 1)[0]!;
      assert.ok(target && !/^[a-z]+:|^\//i.test(target), `${id} must cite repository files`);
      const path = relative(root, resolve(root, dirname(factsFile), target));
      assert.ok(path && path !== ".." && !path.startsWith(`..${sep}`), "source must stay inside the repository");
      cited.add(path.split(sep).join("/"));
    }
  }
  assert.ok(manifest.sources && typeof manifest.sources === "object" && !Array.isArray(manifest.sources));
  assert.deepEqual(Object.keys(manifest.sources).sort(), [...cited].sort(),
    "Every directly cited source must have a fingerprint; remove stale entries too.");
  for (const [path, fingerprint] of Object.entries(manifest.sources)) {
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(sha256(path), fingerprint,
      `${path} changed: review the product claims before refreshing its fingerprint.`);
  }
});
