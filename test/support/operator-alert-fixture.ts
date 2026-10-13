import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorAlertWorkflow } from "../../src/standalone/operator-alert-workflow.ts";
import type { OperatorResponseApproval } from "../../src/standalone/operator-alert-workflow.ts";
import { VoiceOperationalAlertInbox } from "../../src/standalone/voice-operational-alert-inbox.ts";
import { operationalAlertKey } from "../../src/standalone/operational-alert.ts";
import { MagicLinkFixture, syntheticAdminAccount } from "./magic-link-fixture.ts";

export async function withOperatorAlerts(run: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "abby-operator-alerts-"));
  try { await run(await prepare(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
async function prepare(root: string) {
  const accounts = new MagicLinkFixture(), owner = syntheticAdminAccount(), scope = owner.actor.scope;
  const backup = { ...owner, email: "backup@example.test", actor: { ...owner.actor, actorRef: "user-backup", role: "staff" as const } };
  accounts.accounts.set(owner.email, owner); accounts.accounts.set(backup.email, backup);
  let now = "2026-10-13T12:00:00.000Z"; const clock = () => now;
  const receipts = join(root, "receipts"), stateDirectory = join(root, "responsibility"), approvalPath = join(root, "approval.json");
  await mkdir(receipts, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  const approval: OperatorResponseApproval = { scope, revision: "operator-1", approverRef: owner.actor.actorRef, approved: true, enabled: true,
    approvedAt: "2026-10-13T00:00:00.000Z", effectiveFrom: "2026-10-13T00:00:00.000Z", effectiveUntil: "2026-10-30T00:00:00.000Z",
    channel: "authenticatedOperatorInbox", ownerRef: owner.actor.actorRef, backupRef: backup.actor.actorRef,
    escalateAfterMinutes: 10, responsibilityMinutes: 15, alertKinds: ["voiceFailure"] };
  const replaceApproval = (patch: Partial<OperatorResponseApproval> = {}) => writeFile(approvalPath, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 });
  await replaceApproval();
  const tokenHex = "a".repeat(64), alert = { date: "2026-10-13", kind: "voiceFailure" as const, threshold: 2, count: 3 };
  const message = { ...alert, schemaVersion: 1, alertKey: operationalAlertKey(scope, alert.date, alert.kind, alert.threshold, tokenHex) };
  const inbox = new VoiceOperationalAlertInbox({ scope, tokenHex, thresholds: { voiceFailure: 2 }, directory: receipts, clock });
  const accept = () => inbox.accept(message, `Bearer ${tokenHex}`, message.alertKey, new AbortController().signal);
  const restart = async () => {
    const result = await OperatorAlertWorkflow.create({ scope, inbox, stateDirectory, approvalPath, directory: accounts.directory, clock });
    assert.ok(result.ok); return result.value;
  };
  const workflow = await restart();
  return { root, receipts, stateDirectory, approvalPath, accounts, owner, backup, scope, alert, message, tokenHex, inbox,
    workflow, restart, accept, replaceApproval, setTime: (value: string) => { now = value; } };
}
