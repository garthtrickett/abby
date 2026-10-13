import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { request } from "node:http";
import { VoiceOperationalAlertInbox } from "../../src/standalone/voice-operational-alert-inbox.ts";
import { operationalAlertKey } from "../../src/standalone/operational-alert.ts";
import { startVoiceOperationalAlertReceiver } from "../../src/standalone/voice-operational-alert-receiver.ts";

const scope = { tenantId: "alert-tenant", clinicId: "clinic", locationId: "main" }, tokenHex = "a".repeat(64);
const clock = () => "2026-10-13T12:00:00.000Z";
const alert = (patch: Record<string, unknown> = {}, selected = scope) => ({ schemaVersion: 1, date: "2026-10-13", kind: "voiceFailure", count: 3, threshold: 2,
  alertKey: operationalAlertKey(selected, "2026-10-13", "voiceFailure", 2, tokenHex), ...patch });
const signal = () => new AbortController().signal;
async function fixture(run: (root: string, inbox: VoiceOperationalAlertInbox) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "abby-alert-inbox-"));
  try { await run(root, new VoiceOperationalAlertInbox({ scope, tokenHex, thresholds: { voiceFailure: 2 }, directory: root, clock })); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const accept = (inbox: VoiceOperationalAlertInbox, message = alert()) => inbox.accept(message, `Bearer ${tokenHex}`, message.alertKey, signal());

test("E2E-220 shared alert identity preserves the existing sender's published key format", () => {
  assert.equal(operationalAlertKey(scope, "2026-10-13", "voiceFailure", 2, tokenHex),
    "f4b8af62d94255065a2abbd9e86d9feff5030718c653d4b207629b2580b2f719");
});

test("E2E-220 real file inbox deduplicates concurrent instances and retains the first aggregate count", async () => {
  await fixture(async (root, inbox) => {
    const other = new VoiceOperationalAlertInbox({ scope: { locationId: "main", clinicId: "clinic", tenantId: "alert-tenant" }, tokenHex,
      thresholds: { voiceFailure: 2 }, directory: root, clock });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => accept(i % 2 ? other : inbox)));
    assert.ok(results.every(result => result === "accepted"));
    assert.equal(await accept(other, alert({ count: 9 })), "accepted");
    assert.deepEqual(await other.snapshot(), { schemaVersion: 1, alerts: [{ date: "2026-10-13", kind: "voiceFailure", count: 3, threshold: 2 }] });
    const dirs = await readdir(root); assert.equal(dirs.length, 1);
    const names = await readdir(join(root, dirs[0]!)); assert.equal(names.length, 1);
    const stored = await readFile(join(root, dirs[0]!, names[0]!), "utf8");
    for (const secret of [tokenHex, alert().alertKey, scope.tenantId, "phone", "patient", "call", "timestamp"]) assert.equal(stored.includes(secret), false);
    assert.equal(JSON.stringify(inbox).includes(tokenHex), false);
  });
});

test("E2E-220 authentication, clinic binding, exact payload and retained dates reject before any receipt storage", async () => {
  await fixture(async (root, inbox) => {
    for (const message of [alert({ patient: "private-patient-canary" }), alert({ schemaVersion: 2 }), alert({ count: 1 }), alert({ count: 1.5 }),
      alert({ kind: "somewhere" }), alert({ threshold: 1 }), alert({ date: "2026-02-30" }), alert({ date: "2026-10-14" }), alert({ date: "2026-10-06" }),
      alert({}, { ...scope, tenantId: "foreign" })]) assert.equal(await accept(inbox, message), "invalid");
    assert.equal(await inbox.accept(alert(), "Bearer wrong", alert().alertKey, signal()), "invalid");
    assert.equal(await inbox.accept(alert(), `Bearer ${tokenHex}`, "b".repeat(64), signal()), "invalid");
    const stop = new AbortController(); stop.abort(); assert.equal(await inbox.accept(alert(), `Bearer ${tokenHex}`, alert().alertKey, stop.signal), "invalid");
    assert.deepEqual(await readdir(root), []);
  });
});

test("E2E-220 unsafe root, symlink and corrupt receipts cannot acknowledge delivery or expose partial counts", async () => {
  await fixture(async (root, inbox) => {
    await chmod(root, 0o755); assert.equal(await accept(inbox), "unavailable"); await assert.rejects(inbox.snapshot(), /inbox unavailable/);
    await chmod(root, 0o700); assert.equal(await accept(inbox), "accepted");
    const dir = join(root, (await readdir(root))[0]!), name = (await readdir(dir))[0]!;
    await writeFile(join(dir, name), '{"patient":"private-patient-canary"}', { mode: 0o600 });
    await assert.rejects(inbox.snapshot(), /inbox unavailable/); assert.equal(await accept(inbox), "unavailable");
    assert.match(await readFile(join(dir, name), "utf8"), /private-patient-canary/, "unknown/corrupt owner data is not silently deleted");
    await rm(join(dir, name)); await symlink("/does-not-exist", join(dir, name));
    assert.equal(await accept(inbox), "unavailable");
  });
});

test("E2E-220 retention prunes one clinic only and refuses expired replay", async () => {
  await fixture(async (root, inbox) => {
    assert.equal(await accept(inbox), "accepted");
    const foreignScope = { ...scope, tenantId: "other" }, foreign = new VoiceOperationalAlertInbox({ scope: foreignScope, tokenHex,
      thresholds: { voiceFailure: 2 }, directory: root, clock });
    assert.equal(await accept(foreign, alert({}, foreignScope)), "accepted");
    const future = new VoiceOperationalAlertInbox({ scope, tokenHex, thresholds: { voiceFailure: 2 }, directory: root, clock: () => "2026-10-20T12:00:00.000Z" });
    assert.deepEqual((await future.snapshot()).alerts, []); assert.equal(await accept(future), "invalid");
    assert.equal((await foreign.snapshot()).alerts.length, 1, "other clinic's files survive this clinic's cleanup");
  });
});

test("E2E-220 real HTTP receiver accepts durable aggregates and rejects extra fields or unsafe storage", async () => {
  await fixture(async (root, inbox) => {
    const receiver = await startVoiceOperationalAlertReceiver(inbox);
    const url = `http://127.0.0.1:${receiver.port}/voice-operational-alerts`;
    const post = (message = alert()) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${tokenHex}`, "idempotency-key": message.alertKey,
      "content-type": "application/json" }, body: JSON.stringify(message) });
    try {
      assert.equal((await post()).status, 202); assert.equal((await post()).status, 202); assert.equal((await inbox.snapshot()).alerts.length, 1);
      assert.equal((await post(alert({ notes: "private-call-canary" }))).status, 400);
      const oversized = await post(alert({ notes: "x".repeat(2_000) })).then(response => response.status, () => 0);
      assert.notEqual(oversized, 202); assert.equal((await inbox.snapshot()).alerts.length, 1);
      assert.equal((await fetch(url)).status, 400);
      await chmod(root, 0o755); assert.equal((await post()).status, 503);
    } finally { await receiver.close(); }
  });
});

test("E2E-220 incomplete HTTP bodies terminate at the receiver deadline without accepting an alert", { timeout: 10_000 }, async () => {
  await fixture(async (_root, inbox) => {
    const receiver = await startVoiceOperationalAlertReceiver(inbox), started = performance.now();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const pending = request(`http://127.0.0.1:${receiver.port}/voice-operational-alerts`, { method: "POST", headers: {
          "content-type": "application/json", authorization: `Bearer ${tokenHex}`, "idempotency-key": alert().alertKey } }, response => {
          response.resume(); clearTimeout(timeout); resolve(response.statusCode ?? 0); pending.destroy();
        });
        const timeout = setTimeout(() => { pending.destroy(); reject(new Error("receiver body deadline did not settle")); }, 7_500);
        pending.on("error", () => { clearTimeout(timeout); resolve(0); }); pending.write("{");
      });
      assert.notEqual(status, 202); assert.ok(performance.now() - started < 7_000);
      assert.deepEqual((await inbox.snapshot()).alerts, []);
    } finally { await receiver.close(); }
  });
});
