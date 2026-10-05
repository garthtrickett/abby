import { lstatSync } from "node:fs";
import { getuid,loadEnvFile } from "node:process";
import { ClinikoLifecycleFixture,LifecycleFailure } from "../phase-0/probes/cliniko_lifecycle_fixture.ts";
import { runClinikoLifecycle } from "../phase-0/probes/cliniko_lifecycle_rehearsal.ts";

try {
  const [mode,secretArg,recoveryArg]=process.argv.slice(2);
  if(!["preflight","status","run","cleanup"].includes(mode ?? "") || !secretArg?.startsWith("--secret-file=") ||
    !recoveryArg?.startsWith("--recovery-file=") || process.argv.length!==5 || process.env.ABBY_LIVE_CLINIKO_EVAL!=="1") throw new LifecycleFailure("invalidConfig");
  const path=secretArg.slice("--secret-file=".length), metadata=lstatSync(path);
  if(!metadata.isFile() || (metadata.mode&0o077)!==0 || typeof getuid!=="function" || metadata.uid!==getuid()) throw new LifecycleFailure("unsafeSecretFile");
  loadEnvFile(path);
  const apiKey=process.env.ABBY_CLINIKO_API_KEY,contactEmail=process.env.ABBY_CLINIKO_CONTACT_EMAIL;
  if(!apiKey || !contactEmail) throw new LifecycleFailure("missingDemoCredentials");
  const credentials={apiKey,contactEmail},fixture=new ClinikoLifecycleFixture({...credentials,recoveryFile:recoveryArg.slice("--recovery-file=".length)});
  if(mode==="preflight") {
    const catalogue=await fixture.preflight(),p=await fixture.request("GET",`/practitioners/${catalogue.practitioner.id}`);
    console.log(JSON.stringify({ok:true,step:"preflight",mutations:0,practitionerHasLabel:typeof p.label==="string",
      practitionerHasDisplayName:typeof p.display_name==="string",practitionerActive:p.active===true,
      practitionerArchivedNull:p.archived_at===null,practitionerArchiveAbsent:!Object.hasOwn(p,"archived_at")}));
  }
  else if(mode==="status") {await fixture.status((resource,facts)=>console.log(JSON.stringify({resource,...facts})));}
  else if(mode==="cleanup") {await fixture.cleanup();console.log(JSON.stringify({ok:true,step:"cleanup",verified:true}));}
  else console.log(JSON.stringify(await runClinikoLifecycle(fixture,credentials,(step,facts)=>console.log(JSON.stringify({step,...facts})))));
} catch(error) {
  console.log(JSON.stringify({ok:false,kind:error instanceof LifecycleFailure?error.kind:"rehearsalUnavailable"}));process.exitCode=1;
}
