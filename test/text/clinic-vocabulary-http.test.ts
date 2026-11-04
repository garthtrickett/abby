import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { vocabularyDashboard } from "../support/vocabulary-dashboard.ts";

async function proposal(f: Awaited<ReturnType<typeof vocabularyDashboard>>) {
  const response = await fetch(f.url + "/api/clinic-vocabulary", { headers: f.headers });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.ok, true); return result.value;
}
const input = (p: Awaited<ReturnType<typeof proposal>>, manualPublicTerms = ["Published clinic alias"]) => ({
  expectedBinding: p.expectedBinding, expectedRevision: p.expectedRevision, catalogueHash: p.catalogueHash,
  manualPublicTerms, selectedTerms: [], manualPublicConfirmed: true,
});
function save(f: Awaited<ReturnType<typeof vocabularyDashboard>>, body: unknown, headers = f.headers) {
  return fetch(f.url + "/api/clinic-vocabulary", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("authenticated vocabulary HTTP exposes public proposals and persists one owner-approved review without patient authority", async () => {
  const f = await vocabularyDashboard();
  try {
    const first = await proposal(f); assert.deepEqual(first.selectedTerms, ["Physiotherapy"]);
    assert.equal(JSON.stringify(first).includes("Unpublished Person"), false);
    assert.equal(JSON.stringify(first).includes(f.path), false);
    const result = await save(f, input(first)); assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, value: { saved: true } });
    const second = await proposal(f); assert.deepEqual(second.manualTerms, ["Published clinic alias"]);
    assert.deepEqual(second.suggestions, []); assert.notEqual(second.expectedRevision, first.expectedRevision);
    const persisted = await readFile(f.path, "utf8");
    assert.equal((await save(f, input(first))).status, 409);
    assert.equal(await readFile(f.path, "utf8"), persisted);
    for (const Cookie of ["session=staff", "session=other", "session=missing"]) {
      assert.notEqual((await fetch(f.url + "/api/clinic-vocabulary", { headers: { Cookie } })).status, 200);
      assert.notEqual((await save(f, input(second), { Cookie, Origin: f.url })).status, 200);
    }
    assert.equal(await readFile(f.path, "utf8"), persisted);
  } finally { await f.close(); }
});

test("vocabulary HTTP rejects forged Origin actors scopes private fields and unconfirmed manual publication", async () => {
  const f = await vocabularyDashboard();
  try {
    const p = await proposal(f), before = await readFile(f.path, "utf8");
    assert.equal((await save(f, input(p), { Cookie: "session=owner", Origin: "https://elsewhere.invalid" })).status, 403);
    const missingOrigin = await fetch(f.url + "/api/clinic-vocabulary", { method: "POST", headers: { Cookie: "session=owner", "Content-Type": "application/json" }, body: JSON.stringify(input(p)) });
    assert.equal(missingOrigin.status, 403);
    for (const body of [{ ...input(p), actor: { actorRef: "admin" } }, { ...input(p), scope: { clinicId: "other" } },
      { ...input(p), patientName: "PRIVATE PATIENT CANARY" }, { ...input(p), manualPublicConfirmed: false },
      { ...input(p), selectedTerms: ["Unpublished Person"] }, { ...input(p), manualPublicTerms: ["weighted:9"] }]) {
      assert.equal((await save(f, body)).status, 400);
    }
    assert.equal(await readFile(f.path, "utf8"), before);
  } finally { await f.close(); }
});

test("revocation of the authenticated session at vocabulary commit preserves the accepted owner file", async () => {
  const f = await vocabularyDashboard();
  try {
    const p = await proposal(f), before = await readFile(f.path, "utf8");
    f.revokeOnRead(4);
    assert.equal((await save(f, input(p))).status, 503);
    assert.equal(await readFile(f.path, "utf8"), before);
  } finally { await f.close(); }
});
