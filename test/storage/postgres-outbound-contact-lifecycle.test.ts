import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundContactLifecycleFixture } from "../support/outbound-contact-lifecycle.ts";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { value } from "../support/outbound-records.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { ok } from "../../src/core/model.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { OwnerFileOutboundContactAccount } = await import(new URL("standalone/owner-file-outbound-contact-account.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-contact-account.ts");
const { ClinikoOutboundLaunchRecords } = await import(new URL("cliniko/outbound-launch-records.js", emitted).href) as typeof import("../../src/cliniko/outbound-launch-records.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { outboundContactGuardOwnerBinding, outboundCapacityOwnerBinding } = await import(new URL("core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
async function fixture() {
  const apiKey = `synthetic-contact-hold-${randomUUID()}-au5`, scope = { tenantId: `contact-hold-${randomUUID()}`, clinicId: "clinic", locationId: "location" }, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const contactCapacity = new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!);
  const f = await outboundContactLifecycleFixture({ apiKey, scope, guardRef, budget, capacity: contactCapacity,
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign, OwnerFileOutboundContactAccount },
    effectFactory: (s,b) => new PostgresOutboundEffectBarrier(db,s,b), capacityFactory: (s,b) => new PostgresOutboundCapacity(db,s,b) });
  return { ...f, get posts() { return f.posts; }, get claims() { return f.claims; }, apiKey, scope, physicalBudget: budget, contactCapacity };
}
async function privacy(f: Awaited<ReturnType<typeof fixture>>) {
  const notes = [String(f.requestRow.notes), ...(f.posts ? [String(f.retained().row.notes)] : [])];
  const canaries = [f.apiKey, f.request.recipient.number, "cliniko:recall:30", ...notes.map(note => note.split("\n")[1]!)];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value,i) => ({ label: `contact_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  for (const canary of [...canaries, ...notes]) assert.equal(dump.includes(canary), false);
}
for (const mode of ["accepted", "unknown", "knownUninvoked", "lateNumberGrant", "quota", "concurrent"] as const)
  test(`compiled guarded native180 launch and opaque SQL: ${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(); t.after(f.close);
    if (mode === "unknown") f.controls.mode = "unknown";
    if (mode === "knownUninvoked") f.controls.retainResponse = () => Response.json({}, { status: 503 });
    if (mode === "lateNumberGrant") f.controls.beforeEdge = () => { f.safetyState.live = false; };
    if (mode === "quota") for (let n = 0; n < 180; n++) if (await f.physicalBudget.claim() !== null) break;
    const result = mode === "concurrent" ? await Promise.all([f.launch(), value(f.make()).launchOnce(f.binding, new AbortController().signal)]) : [await f.launch()];
    const invoked = ["accepted", "unknown", "lateNumberGrant", "concurrent"].includes(mode);
    if (mode === "accepted" || mode === "concurrent") assert.equal(result.filter(r => r.ok && r.value.kind === "accepted").length, 1);
    if (mode === "unknown") assert.equal(value(result[0]!).kind, "unknown");
    if (mode === "knownUninvoked" || mode === "quota") assert.equal(result[0]!.ok, false);
    assert.equal(f.calls.length, invoked && mode !== "lateNumberGrant" ? 1 : 0);
    const rows = (await sql<{owner_binding:string;allocation_ref:string;released_at:Date|null}>`select owner_binding, allocation_ref, released_at from outbound_capacity_allocations where tenant_id=${f.scope.tenantId}`.execute(db)).rows;
    const contact = rows.filter(row => row.owner_binding === outboundContactGuardOwnerBinding(f.guardRef)), normal = rows.filter(row => row.owner_binding === outboundCapacityOwnerBinding(f.request.campaignRef));
    assert.equal(contact.filter(row => row.released_at === null).length, invoked ? 1 : 0);
    assert.equal(normal.filter(row => row.released_at === null).length, invoked ? 1 : 0);
    if (invoked) {
      const { attempt } = f.retained(); assert.equal(attempt.contactReferences?.allocationRef, contact.find(r => r.released_at === null)?.allocation_ref);
      // A cold owner under another location/campaign cannot hide the clinic hold.
      const cold = new PostgresOutboundCapacity(db, { ...f.scope, locationId: "other-location" }, outboundContactGuardOwnerBinding(f.guardRef)!);
      assert.deepEqual(value(await cold.acquireOnce(randomUUID(), 1)), { kind: "full" });
    }
    assert.ok(f.claims <= 180); await privacy(f);
  });
for (const hold of ["nativeAck", "provider"] as const)
  test(`compiled guarded owner SIGKILL after ${hold} preserves clinic contact hold and native recovery context`, { timeout: 30000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const cwd = await mkdtemp(join(tmpdir(), "abby-contact-hold-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
    let reached!:()=>void; const submitted = new Promise<void>(resolve => { reached=resolve; });
    const peer = await outboundLaunchPeer(f,cwd,reached,hold,undefined,{guardRef:f.guardRef,accountPath:f.captureConfig.path,maximumNativeRequests:20,numberStops:f.ports.numberStops,native:f.native}); t.after(peer.kill);
    await Promise.race([submitted,peer.errors,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error("Synthetic guarded owner did not reach held dispatch")),20000);t.after(()=>clearTimeout(timer));})]);
    await peer.kill(); assert.deepEqual(peer.output,[]); assert.deepEqual(await readdir(cwd),[]);
    const { row, attempt }=f.retained();
    row.recalled=true; row.recalled_at=f.state.now; row.archived_at=f.state.now; row.updated_at=f.state.now;
    const reader=value(ClinikoOutboundLaunchRecords.createReadOnly(f.config.attempts,f.ports.attempt,f.native));
    const recovered=value(await reader.readPossibleAttempt({recallRef:`cliniko:recall:${row.id}`,actionRef:attempt.actionRef,patientId:attempt.patientId},new AbortController().signal));
    assert.deepEqual(recovered.attempt,attempt);assert.equal(recovered.archivedAt,f.state.now);
    assert.ok(Object.isFrozen(recovered.attempt.contactReferences));
    assert.equal(attempt.contactReferences?.guardRef,f.guardRef); assert.ok(attempt.contactReferences?.outcomeActionRef);
    const rows=(await sql<{owner_binding:string;allocation_ref:string;released_at:Date|null}>`select owner_binding, allocation_ref, released_at from outbound_capacity_allocations where tenant_id=${f.scope.tenantId}`.execute(db)).rows;
    assert.equal(rows.length,2); assert.ok(rows.every(row=>row.released_at===null));
    assert.equal(rows.find(row=>row.owner_binding===outboundContactGuardOwnerBinding(f.guardRef))?.allocation_ref,attempt.contactReferences?.allocationRef);
    assert.deepEqual(value(await new PostgresOutboundCapacity(db,{...f.scope,locationId:"cold-location"},outboundContactGuardOwnerBinding(f.guardRef)!).acquireOnce(randomUUID(),1)),{kind:"full"});
    assert.equal(f.calls.length,hold==="provider"?1:0); await privacy(f);
  });
test("contact holds survive real export/import remapping and missing-row detection independently of normal call release", async () => {
  const source={tenantId:`contact-source-${randomUUID()}`,clinicId:"clinic",locationId:"one"},target={tenantId:`contact-target-${randomUUID()}`,clinicId:"new-clinic",locationId:"two"},guard=outboundContactGuardOwnerBinding(randomUUID())!,held=randomUUID(),released=randomUUID();
  value(await new PostgresPolicyStore(db,referenceDefaultPolicy).changeBookingEnabled(source,"0",true,"fixture-owner"));
  const contact=new PostgresOutboundCapacity(db,source,guard); value(await contact.acquireOnce(held,1));
  const normal=new PostgresOutboundCapacity(db,source,outboundCapacityOwnerBinding(randomUUID())!); value(await normal.acquireOnce(released,1)); value(await normal.releaseOnce(released));
  const archive=value(await buildPostgresTenantConfigArchive(db,{sourceTenantId:source.tenantId,archiveId:`contact-archive-${randomUUID()}`,actorRef:"fixture-owner",createdAt:new Date().toISOString(),locations:[{sourceScope:source,targetScope:target,timeZone:"UTC",mappingProvenance:"clinic-reviewed-contact-cutover"}]},{authorizeAndRecord:async()=>ok({requestRef:`contact-export-${randomUUID()}`})}));
  const decoded=value(await decodeTenantConfigArchive(archive,target.tenantId)); assert.equal(decoded.locations[0]!.outboundCapacity!.length,2);
  value(await new PostgresTenantConfigArchiveImporter(db).stage(archive,target.tenantId,"fixture-owner",{authorizeAndRecord:async()=>ok({auditRef:`contact-import-${randomUUID()}`})},{mapRef:()=>"disabled"}));
  const cold=new PostgresOutboundCapacity(db,target,guard);assert.deepEqual(value(await cold.acquireOnce(randomUUID(),1)),{kind:"full"});
  await sql`delete from outbound_capacity_allocations where tenant_id=${target.tenantId} and allocation_ref=${held}::uuid`.execute(db);
  assert.deepEqual(await cold.acquireOnce(randomUUID(),1),{ok:false,error:{kind:"storageFailure"}});
});
