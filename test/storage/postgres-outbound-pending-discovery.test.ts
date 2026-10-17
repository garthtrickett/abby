import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundPendingFixture } from "../support/outbound-pending.ts";
import { outboundRecordPeer } from "../support/outbound-record-peer.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
for (const mode of ["pending", "accountDenied", "recordDenied", "changed"] as const)
  test(`compiled native pending ${mode} keeps private context outside SQL, backups and worker output`,{timeout:35000},async t=>{
    const f=await outboundPendingFixture();f.f.denyProducer();
    if(mode==="accountDenied")f.denyAccount();if(mode==="recordDenied")f.denyRecord();
    if(mode==="changed")f.controls.get=original=>Response.json({...original,recalled:true,recalled_at:original.updated_at});
    f.f.port=f.port;
    const dir=await mkdtemp(join(tmpdir(),"abby-outbound-pending-"));t.after(()=>rm(dir,{recursive:true,force:true}));
    const peer=await outboundRecordPeer(f.f,dir,{mode:"pending",pendingAuthority:f.authority});t.after(peer.kill);
    const result=await peer.nextResult();await peer.kill();
    if(mode==="pending"){
      const found=value(result);assert.equal(found.kind,"pendingRecipientContext");if(found.kind!=="pendingRecipientContext")assert.fail();
      assert.equal(found.records.length,1);assert.deepEqual(found.records[0]!.request,f.f.request);assert.equal(f.calls.length,2);
    } else assert.deepEqual(result,{ok:false,error:{kind:mode==="changed"?"mismatched":"forbidden"}});
    assert.equal((await sql`select effect_ref from outbound_effect_barriers where tenant_id=${f.f.request.scope.tenantId}`.execute(db)).rows.length,0);
    assert.deepEqual(peer.output,[]);assert.deepEqual(await readdir(dir),[]);
    const canaries=[f.f.request.recipient.number,outboundRecipientRequestDigest(f.f.request)!,"Abby outbound recipient request v1","discard-native-outbound-private"];
    assert.deepEqual(await scanPatientDataCanaries(db,canaries.map((value,i)=>({label:`outbound_pending_${i}`,value}))),{ok:true,value:[]});
    const dump=execFileSync("pg_dump",[process.env.DATABASE_URL!,"--no-owner","--no-privileges"],{timeout:10000,maxBuffer:8_000_000}).toString();
    for(const canary of canaries)assert.equal(dump.includes(canary),false);
  });
