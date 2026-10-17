import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundRecordsFixture, value, outboundNow } from "../support/outbound-records.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { outboundRecordPeer } from "../support/outbound-record-peer.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
async function setup() {
  const original = outboundRequestValue(), request = { ...original, scope: { ...original.scope, tenantId: `outbound-compiled-${randomUUID()}` },
    purpose: "sickDay" as const, appointment: { ref: "cliniko:appointment:91", digest: "c".repeat(64) } };
  const f = await outboundRecordsFixture({ request }), native = f.port;
  f.port = async (input, init) => {
    if (init?.method === "POST") {
      assert.equal((await claims(f, f.request.actionRef)).length, 1, "actual permanent record exclusion precedes native POST");
      for (const id of [f.request.effectRef, f.request.approvalRef]) assert.equal((await claims(f, id)).length, 0, "record permission cannot burn future launch IDs");
    }
    return native(input, init);
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function claims(f: Awaited<ReturnType<typeof outboundRecordsFixture>>, ref: string) {
  return (await sql`select effect_ref from outbound_effect_barriers where tenant_id=${f.request.scope.tenantId} and effect_ref=${ref}::uuid`.execute(db)).rows;
}
async function directory() { return mkdtemp(join(tmpdir(), "abby-outbound-record-")); }
async function privacy(f: Fixture) {
  const canaries = [f.request.recipient.number, "Abby outbound recipient request v1", outboundRecipientRequestDigest(f.request)!,
    "cliniko:appointment:91", "discard-native-outbound-private"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `outbound_record_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
}
test("compiled native recorder consumes real SQL exclusion once and read-only cold inspection preserves closure without producer permission", { timeout: 35000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await outboundRecordPeer(f, dir); t.after(first.kill); const retained = value(await first.nextResult()); await first.kill(); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") assert.fail();
  const cold = await outboundRecordPeer(f, dir); t.after(cold.kill);
  assert.deepEqual(await cold.nextResult(), { ok: false, error: { kind: "alreadyClaimed" } }); await cold.kill();
  const row = f.rows.get(retained.recallRef.split(":").at(-1)!)!; row.recalled = true; row.recalled_at = outboundNow; row.archived_at = outboundNow;
  const reader = await outboundRecordPeer(f, dir, { mode: "read", recallRef: retained.recallRef, denied: "producer" }); t.after(reader.kill);
  const read = value(await reader.nextResult()); await reader.kill(); assert.equal(read.kind, "recipientRequestContext");
  if (read.kind !== "recipientRequestContext") assert.fail(); assert.equal(read.recalled, true); assert.equal(read.recalledAt, outboundNow); assert.equal(read.archivedAt, outboundNow);
  assert.deepEqual(read.request, f.request); assert.equal(Object.hasOwn(read, "private_unknown"), false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1); assert.deepEqual([...first.output, ...cold.output, ...reader.output], []);
  for (const id of [f.request.effectRef, f.request.approvalRef]) assert.equal((await claims(f, id)).length, 0);
  assert.deepEqual(await readdir(dir), []); await privacy(f);
});
test("concurrent compiled record owners share the actual opaque SQL exclusion", { timeout: 35000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const [a, b] = await Promise.all([outboundRecordPeer(f, dir), outboundRecordPeer(f, dir)]); t.after(a.kill); t.after(b.kill);
  const results = await Promise.all([a.nextResult(), b.nextResult()]); await a.kill(); await b.kill();
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1); assert.equal(f.calls.filter(c => c.method === "POST").length, 1); await privacy(f);
});
test("SIGKILL after provider POST leaves real SQL consumption and native context without replay or launch IDs", { timeout: 35000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  let submitted!: () => void; const pending = new Promise<void>(resolve => { submitted = resolve; });
  const first = await outboundRecordPeer(f, dir, { holdPostReply: true, onSubmitted: submitted }); t.after(first.kill);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic native dispatch deadline")), 10000); })]); }
  finally { if (timer) clearTimeout(timer); }
  await first.kill(); assert.equal(f.rows.size, 1);
  const cold = await outboundRecordPeer(f, dir); t.after(cold.kill); assert.deepEqual(await cold.nextResult(), { ok: false, error: { kind: "alreadyClaimed" } }); await cold.kill();
  assert.equal(f.calls.length, 1); for (const id of [f.request.effectRef, f.request.approvalRef]) assert.equal((await claims(f, id)).length, 0); await privacy(f);
});
for (const denied of ["record", "producer"] as const)
  test(`compiled independent ${denied} denial prevents record SQL and provider I/O`, { timeout: 35000 }, async t => {
    const f = await setup(), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
    const peer = await outboundRecordPeer(f, dir, { denied }); t.after(peer.kill); const result = await peer.nextResult(); await peer.kill();
    assert.deepEqual(result, { ok: false, error: { kind: "forbidden" } }); assert.equal(f.calls.length, 0); assert.equal((await claims(f, f.request.actionRef)).length, 0); await privacy(f);
  });
