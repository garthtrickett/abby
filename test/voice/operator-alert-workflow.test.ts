import assert from "node:assert/strict";
import { chmod, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withOperatorAlerts } from "../support/operator-alert-fixture.ts";
import { startVoiceOperationalAlertReceiver } from "../../src/standalone/voice-operational-alert-receiver.ts";
import { OperatorAlertStateStore } from "../../src/standalone/operator-alert-state.ts";
import { OperatorAlertWorkflow } from "../../src/standalone/operator-alert-workflow.ts";

test("E2E-220 receipt acceptance starts approved escalation without implying acknowledgment", async () => {
  await withOperatorAlerts(async f => {
    const receiver = await startVoiceOperationalAlertReceiver(f.inbox, 0, f.workflow);
    try {
      const response = await fetch(`http://127.0.0.1:${receiver.port}/voice-operational-alerts`, { method: "POST", headers: {
        authorization: `Bearer ${f.tokenHex}`, "idempotency-key": f.message.alertKey, "content-type": "application/json" }, body: JSON.stringify(f.message) });
      assert.equal(response.status, 202);
      assert.deepEqual(await f.workflow.view(f.owner.actor), [{ alert: f.alert, version: 0, state: "awaitingOwner", assignedTo: "you", canAcknowledge: true }]);
      assert.equal(await f.workflow.acknowledge(f.backup.actor, f.alert, 0), "forbidden");
      const restarted = await f.restart(); f.setTime("2026-10-13T12:10:00.000Z");
      assert.equal((await restarted.view(f.owner.actor))[0]?.state, "awaitingBackup");
      assert.equal(await restarted.acknowledge(f.owner.actor, f.alert, 0), "forbidden");
      assert.equal(await restarted.acknowledge(f.backup.actor, f.alert, 0), "acknowledged");
      assert.equal((await restarted.view(f.backup.actor))[0]?.responsibilityUntil, "2026-10-13T12:25:00.000Z");
    } finally { await receiver.close(); }
  });
});

test("E2E-220 concurrent operator acknowledgment is durable, idempotent and cannot reset observation or patient state", async () => {
  await withOperatorAlerts(async f => {
    assert.equal(await f.accept(), "accepted"); await f.workflow.observe();
    const other = await f.restart();
    const results = await Promise.all([f.workflow, other].map(w => w.acknowledge(f.owner.actor, f.alert, 0)));
    assert.deepEqual(results, ["acknowledged", "acknowledged"]);
    assert.equal((await (await f.restart()).view(f.owner.actor))[0]?.version, 1);
    assert.equal(await f.workflow.acknowledge(f.backup.actor, f.alert, 1), "conflict");
    const before = await f.inbox.snapshot();
    f.setTime("2026-10-13T12:15:00.000Z");
    assert.equal((await f.workflow.view(f.backup.actor))[0]?.state, "awaitingBackup");
    assert.equal(await f.workflow.acknowledge(f.backup.actor, f.alert, 0), "conflict");
    assert.equal(await f.workflow.acknowledge(f.backup.actor, f.alert, 1), "acknowledged");
    assert.deepEqual(await f.inbox.snapshot(), before, "responsibility does not mutate transport acceptance");
    const dir = join(f.stateDirectory, (await readdir(f.stateDirectory))[0]!);
    const child = join(dir, (await readdir(dir))[0]!);
    assert.deepEqual((await readdir(child)).sort(), ["0.json", "1.json", "2.json"]);
    const stored = await readFile(join(child, "2.json"), "utf8");
    assert.equal(JSON.parse(stored).firstObservedAt, "2026-10-13T12:00:00.000Z");
    for (const secret of [f.tokenHex, f.message.alertKey, f.owner.email, f.backup.email, "patientId", "callId", "session"]) assert.equal(stored.includes(secret), false);
    f.setTime("2026-10-13T12:14:00.000Z"); await assert.rejects(f.workflow.view(f.backup.actor), /workflow unavailable/);
  });
});

test("E2E-220 current authority revocation, membership change and foreign actors cannot claim responsibility", async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    for (const actor of [{ ...f.owner.actor, role: "staff" as const }, { ...f.owner.actor, scope: { ...f.scope, locationId: "foreign" } },
      { ...f.owner.actor, actorRef: "unknown" }]) await assert.rejects(f.workflow.view(actor), /workflow unavailable/);
    assert.equal(await f.workflow.acknowledge(f.owner.actor, { ...f.alert, count: 9 }, 0), "forbidden");
    assert.equal(await f.workflow.acknowledge(f.owner.actor, f.alert, 0), "acknowledged");
    f.accounts.accounts.set(f.backup.email, { ...f.backup, membershipVersion: "changed" });
    assert.equal((await f.workflow.view(f.backup.actor))[0]?.state, "awaitingBackup", "membership drift invalidates old responsibility");
    await f.replaceApproval({ enabled: false });
    await assert.rejects(f.workflow.acknowledge(f.backup.actor, f.alert, 1), /workflow unavailable/);
    await f.replaceApproval(); f.accounts.accounts.delete(f.backup.email);
    await assert.rejects(f.workflow.view(f.owner.actor), /workflow unavailable/);
  });
});

test("E2E-220 corrupt or unsafe responsibility storage fails closed and preserves unknown files", async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    await chmod(f.stateDirectory, 0o755); await assert.rejects(f.workflow.view(f.owner.actor)); await chmod(f.stateDirectory, 0o700);
    const dir = join(f.stateDirectory, (await readdir(f.stateDirectory))[0]!);
    const child = join(dir, (await readdir(dir))[0]!);
    const unknown = join(child, "unknown.json"); await writeFile(unknown, '{"private":"unknown-owner-data"}', { mode: 0o600 });
    await assert.rejects(f.workflow.acknowledge(f.owner.actor, f.alert, 0));
    f.setTime("2026-10-21T12:00:00.000Z"); await assert.rejects(f.workflow.observe());
    assert.match(await readFile(unknown, "utf8"), /unknown-owner-data/);
  });
});

test("E2E-220 response state retention removes expired aggregate governance without changing other scopes", async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe(); const before = await readdir(f.stateDirectory);
    assert.equal(await f.workflow.acknowledge(f.owner.actor, f.alert, 0), "acknowledged");
    f.setTime("2026-10-13T12:15:00.000Z"); assert.equal(await f.workflow.acknowledge(f.backup.actor, f.alert, 1), "acknowledged");
    const own = join(f.stateDirectory, before[0]!);
    await unlink(join(own, (await readdir(own))[0]!, "1.json")); // An interrupted expiry pass may already have removed an older version.
    const foreign = new OperatorAlertStateStore(f.stateDirectory, { ...f.scope, tenantId: "other" });
    assert.equal(await foreign.compareAndSet(undefined, { schemaVersion: 1, version: 0, alert: f.alert, firstObservedAt: "2026-10-13T12:00:00.000Z",
      policyFingerprint: "b".repeat(64), acknowledgment: null }), true);
    assert.equal(before.length, 1); f.setTime("2026-10-21T12:00:00.000Z");
    assert.deepEqual(await f.workflow.view(f.owner.actor), []);
    assert.deepEqual(await readdir(join(f.stateDirectory, before[0]!)), []);
    assert.ok(await foreign.read(f.alert), "another clinic's state survives local retention");
  });
});

test("E2E-220 missing initial state cannot hide unknown owner data behind an empty response", async () => {
  await withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    const scope = join(f.stateDirectory, (await readdir(f.stateDirectory))[0]!);
    const child = join(scope, (await readdir(scope))[0]!);
    await unlink(join(child, "0.json")); await writeFile(join(child, "unknown.json"), '{"private":"orphan-owner-data"}', { mode: 0o600 });
    f.setTime("2026-10-21T12:00:00.000Z"); await assert.rejects(f.workflow.view(f.owner.actor), /state unavailable/);
    assert.match(await readFile(join(child, "unknown.json"), "utf8"), /orphan-owner-data/);
  });
});

test("E2E-220 changed or malformed approval cannot activate response ownership or falsely accept observation", async () => {
  await withOperatorAlerts(async f => {
    const receiver = await startVoiceOperationalAlertReceiver(f.inbox, 0, f.workflow);
    const url = `http://127.0.0.1:${receiver.port}/voice-operational-alerts`;
    try {
      await f.replaceApproval({ enabled: false });
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.tokenHex}`, "idempotency-key": f.message.alertKey,
        "content-type": "application/json" }, body: JSON.stringify(f.message) });
      assert.equal(response.status, 503);
      assert.deepEqual((await f.inbox.snapshot()).alerts, [f.alert]);
      const create = () => OperatorAlertWorkflow.create({ scope: f.scope, inbox: f.inbox, stateDirectory: f.stateDirectory, approvalPath: f.approvalPath,
        directory: f.accounts.directory, clock: () => "2026-10-13T12:00:00.000Z" });
      for (const patch of [{ enabled: false }, { backupRef: f.owner.actor.actorRef }, { responsibilityMinutes: 0 }, { alertKinds: ["voiceFailure", "voiceFailure"] as const }]) {
        await f.replaceApproval(patch); assert.equal((await create()).ok, false);
      }
      await f.replaceApproval(); assert.equal((await create()).ok, true);
      await f.workflow.observe(); assert.equal((await f.workflow.view(f.owner.actor))[0]?.state, "awaitingOwner");
    } finally { await receiver.close(); }
  });
});
