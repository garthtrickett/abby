// Native-adapter qualification only: source facts/grants below are synthetic.
// Actual trusted clinical receipt capture and host integration remain separate.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { administrativeMemoInput } from "../support/administrative-memo.ts";
import { value } from "../support/outbound-records.ts";
import type { AdministrativeMemoConfig } from "../../src/cliniko/administrative-memo-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { AdministrativeMemoAuthentication, encodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { ClinikoAdministrativeMemos, administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");

for (const scenario of ["accepted", "lostStored", "lostUnstored", "parallel", "changedPolicyAndKey"] as const)
test(`actual emitted confidential memo native primitive retains one SQL purpose and full backup privacy: ${scenario}`, { timeout: 30000 }, async () => {
  const input = administrativeMemoInput(), key = randomBytes(32), auth = new AdministrativeMemoAuthentication(key);
  const apiKey = `synthetic-memo-${randomUUID()}-au5`, scope = { tenantId: `memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const patientId = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 1_000_000_000_000_000_000n + 1_000_000_000_000_000_000n).toString();
  const memo = value(auth.sign({ ...input, scope, patientId, credentialFingerprint: clinikoCredentialFingerprint(apiKey) }));
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const config: AdministrativeMemoConfig = { scope, apiKey, contactEmail: "ops@example.invalid", businessId: memo.businessId, authorRef: memo.authorRef,
    policy: memo.policy, rateBudget: budget, clock: () => memo.recordedAt, deadlineMs: 5000 };
  let posts = 0, nativeWire = ""; const rows = new Map<string, Record<string, unknown>>();
  const native: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init!.headers).get("authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    if (init!.method === "POST") {
      assert.equal(u.pathname, "/v1/communications"); posts++; nativeWire = String(init!.body); const body = JSON.parse(nativeWire);
      assert.equal(body.patient_id, patientId); assert.equal(body.confidential, true); assert.equal(body.category_code, 12); assert.equal(body.type_code, 3);
      const row = { ...body, id: "701", created_at: memo.recordedAt, updated_at: memo.recordedAt, archived_at: null,
        links: { self: "https://api.au5.cliniko.com/v1/communications/701" }, patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } } };
      if (scenario !== "lostUnstored" && scenario !== "changedPolicyAndKey") rows.set("701", row);
      if (scenario === "lostStored" || scenario === "lostUnstored" || scenario === "changedPolicyAndKey") throw Error("Synthetic native acknowledgement lost");
      return Response.json(row, { status: 201 });
    }
    assert.equal(init!.method, "GET"); assert.equal(u.searchParams.get("q[]"), "archived_at:*");
    const row = rows.get(u.pathname.split("/").at(-1)!); return row ? Response.json(row) : new Response(null, { status: 404 });
  };
  // These grants are deliberately synthetic adapter grants, not proof that a
  // caller/model may assert a confirmed clinical result.
  const grants = { allows: async () => true, current: () => true, producerAdmitted: async () => true };
  const owner = administrativeMemoRecordBinding(config, auth)!, barrier = new PostgresOutboundEffectBarrier(db, scope, owner);
  const client = value(ClinikoAdministrativeMemos.create(config, auth, grants, barrier, native));
  if (scenario === "parallel") {
    const results = await Promise.all([client.retainOnce(memo, new AbortController().signal), client.retainOnce(memo, new AbortController().signal)]);
    assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
    assert.equal(results.filter(r => !r.ok && r.error.kind === "alreadyClaimed").length, 1);
  } else {
    assert.equal(value(await client.retainOnce(memo, new AbortController().signal)).kind, scenario === "accepted" ? "accepted" : "uncertain");
    assert.equal((await client.retainOnce(memo, new AbortController().signal)).ok, false);
  }
  assert.equal(posts, 1);
  if (scenario === "changedPolicyAndKey") {
    const nextAuth = new AdministrativeMemoAuthentication(randomBytes(32)), policy = { version: "next", digest: "b".repeat(64) };
    const nextConfig = { ...config, policy }, nextMemo = value(nextAuth.sign({ ...input, scope, patientId, credentialFingerprint: memo.credentialFingerprint, policy }));
    assert.equal(nextMemo.actionRef, memo.actionRef);
    const next = value(ClinikoAdministrativeMemos.create(nextConfig, nextAuth, grants, new PostgresOutboundEffectBarrier(db, scope, administrativeMemoRecordBinding(nextConfig, nextAuth)!), native));
    assert.equal((await next.retainOnce(nextMemo, new AbortController().signal)).ok, false); assert.equal(posts, 1);
  }
  const effects = (await sql<{ effect_ref: string; owner_binding: string }>`select effect_ref,owner_binding from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
  assert.deepEqual(effects, [{ effect_ref: memo.actionRef, owner_binding: owner }]);
  const reader = value(ClinikoAdministrativeMemos.createReadOnly(config, auth, grants, native));
  const read = await reader.readMemo({ communicationRef: "cliniko:communication:701", actionRef: memo.actionRef, patientId }, new AbortController().signal);
  assert.equal(read.ok, ["accepted", "lostStored", "parallel"].includes(scenario));
  const content = value(encodeAdministrativeMemo(memo)); assert.notEqual(nativeWire, "");
  const canaries = [apiKey, patientId, content, nativeWire, key.toString("hex"), memo.authentication, Buffer.from(`${apiKey}:`).toString("base64")];
  const chunks = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, j) => ({ label: `memo_${i}_${j}`,
    value: text.slice(j * 256, (j + 1) * 256).length < 4 ? text.slice(-4) : text.slice(j * 256, (j + 1) * 256) })));
  for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const v of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(v), false); }
});
