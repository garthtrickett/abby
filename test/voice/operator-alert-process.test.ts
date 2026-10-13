import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { withOperatorAlerts } from "../support/operator-alert-fixture.ts";

test("E2E-220 independently compiled operator processes publish one acceptance and fresh processes recover it", async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    const accountsPath = join(f.root, "accounts.json");
    await writeFile(accountsPath, JSON.stringify([f.owner, f.backup]), { mode: 0o600 });
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(resolve(`dist/runtime/src/standalone/${name}.js`)).href);
    const program = `
      import { OperatorAlertWorkflow } from ${moduleUrl("operator-alert-workflow")};
      import { VoiceOperationalAlertInbox } from ${moduleUrl("voice-operational-alert-inbox")};
      import { OwnerFileAdminDirectory } from ${moduleUrl("identity/owner-file-admin-directory")};
      try {
        const f = JSON.parse(process.env.ABBY_OPERATOR_PROCESS_FIXTURE);
        if (f.scope.tenantId !== 'identity-tenant' || !f.stateDirectory.startsWith('/tmp/abby-operator-alerts-')) throw Error();
        const clock = () => '2026-10-13T12:00:00.000Z';
        const inbox = new VoiceOperationalAlertInbox({scope:f.scope, directory:f.receipts, tokenHex:f.tokenHex, thresholds:{voiceFailure:2}, clock});
        const result = await OperatorAlertWorkflow.create({scope:f.scope,inbox,stateDirectory:f.stateDirectory,approvalPath:f.approvalPath,
          directory:new OwnerFileAdminDirectory(f.accountsPath,f.scope),clock});
        if (!result.ok) throw Error();
        const value = await result.value.acknowledge(f.actor,f.alert,0);
        process.stdout.write(JSON.stringify({value,version:(await result.value.view(f.actor))[0].version}));
      } catch { process.stderr.write('operator process unavailable'); process.exitCode=1; }
    `;
    const execute = () => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", program], { timeout: 15_000, maxBuffer: 2048,
      env: { ...process.env, ABBY_OPERATOR_PROCESS_FIXTURE: JSON.stringify({ scope: f.scope, receipts: f.receipts, stateDirectory: f.stateDirectory,
        approvalPath: f.approvalPath, accountsPath, tokenHex: f.tokenHex, alert: f.alert, actor: f.owner.actor }) } });
    for (const result of await Promise.all([execute(), execute(), execute(), execute()])) {
      assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), { value: "acknowledged", version: 1 });
    }
    assert.deepEqual(JSON.parse((await execute()).stdout), { value: "acknowledged", version: 1 });
    assert.equal((await f.workflow.view(f.owner.actor))[0]?.version, 1);
  });
});
