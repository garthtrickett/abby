import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { value } from "../support/outbound-records.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { postgresTwilioOutboundFixture as fixture, postgresTwilioOutboundPrivacy as privacy } from "../support/postgres-twilio-outbound.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());

for (const mode of ["accepted", "lostAck", "foreignAck"] as const)
  test(`emitted Twilio + real native180 SQL launch holds and cold original binding: ${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(db, mode); t.after(f.close);
    assert.deepEqual(value(await f.launch()), { kind: mode === "accepted" ? "accepted" : "unknown", capacity: "held" });
    assert.equal(f.requests, 1); assert.equal(f.posts, 1); assert.ok(f.claims <= 180);
    const cold = f.recover(), { attempt } = f.retained();
    assert.equal(cold.call.context.attemptDigest, outboundLaunchAttemptDigest(attempt));
    const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db)).rows;
    assert.equal(rows.length, 2); assert.equal((await f.launch()).ok, false); assert.equal(f.requests, 1);
    await privacy(db, f);
  });
test("actual emitted Twilio owner killed after one submission cold-recovers sealed original context without replay or a private file/SQL map", { timeout: 30000 }, async t => {
  const f = await fixture(db); t.after(f.close); const cwd = await mkdtemp(join(tmpdir(), "abby-twilio-owner-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let submitted!: () => void; const began = new Promise<void>(r => { submitted = r; });
  const peer = await outboundLaunchPeer(f, cwd, submitted, "provider", undefined, { guardRef: f.guardRef, accountPath: f.captureConfig.path,
    maximumNativeRequests: 20, numberStops: f.ports.numberStops, native: f.native, twilio: { config: f.twilioConfig, transport: f.transport } }); t.after(peer.kill);
  await Promise.race([began, peer.errors, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(Error("Synthetic Twilio submission not reached")), 20000); t.after(() => clearTimeout(timer)); })]);
  await peer.kill(); assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(cwd), []);
  const cold = f.recover(), { attempt } = f.retained(); assert.equal(f.requests, 1); assert.equal(cold.call.context.attemptDigest, outboundLaunchAttemptDigest(attempt));
  const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db)).rows;
  assert.equal(rows.length, 2); assert.equal((await f.launch()).ok, false); assert.equal(f.requests, 1); await privacy(db, f);
});
