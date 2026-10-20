import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handoffFixture } from "../support/financial-webhook-handoff.ts";
import { now } from "../support/financial-checkout-owner.ts";

test("acknowledged handoff survives handler process loss through preexisting native work, with no local queue or effect replay", { timeout: 30_000 }, async t => {
  const f = await handoffFixture(), records = structuredClone([...f.rows]), burned = [...f.burned];
  const dir = await mkdtemp(join(tmpdir(), "abby-webhook-loss-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const { producer, rateBudget: _budget, clock: _nativeClock, ...cliniko } = f.config.cliniko;
  const { clock: _stripeClock, ...stripe } = f.config.stripe, { clock: _webhookClock, ...webhook } = f.config.webhook;
  const e = f.signed();
  const run = async (mode: "accept" | "rediscover") => {
    const child = fork(new URL("../support/financial-webhook-process.ts", import.meta.url), [], { cwd: dir,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=128" } });
    const exited = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic webhook worker deadline")), 10_000);
        child.once("error", reject); child.once("exit", () => reject(new Error("Synthetic worker ended before result")));
        child.on("message", async (raw: unknown) => {
          const m = raw as { kind: string; id: number; input: string; method: string; headers: Record<string, string>; result: unknown };
          try {
            if (m.kind === "result") { resolve(m.result); return; }
            if (m.kind === "workerError") throw new Error("Synthetic worker unavailable");
            assert.equal(m.kind, "fetch"); assert.equal(m.method, "GET");
            const response = await (m.input.startsWith("https://api.stripe.com/") ? f.stripePort : f.nativePort)(m.input,
              { method: m.method, headers: m.headers, redirect: "error" });
            if (child.connected) child.send({ kind: "reply", id: m.id, data: { body: await response.text(), status: response.status } });
          } catch (error) { reject(error); }
        });
        child.send({ kind: "start", mode, now, raw: e.raw, signature: e.signature, config: { cliniko: { ...cliniko,
          producer: { keyRef: producer.keyRef, pem: producer.publicKey.export({ type: "spki", format: "pem" }).toString() } }, stripe, webhook } });
      });
      assert.ok(child.pid); assert.equal(child.kill("SIGKILL"), true); assert.equal(await exited, "SIGKILL"); return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  };
  assert.deepEqual(await run("accept"), { ok: true, value: { kind: "acceptedExistingPending" } });
  // A fresh process knows no event ledger, selected recall refs or local queue.
  assert.deepEqual(await run("rediscover"), { work: 1, attempts: 1, paired: 1 });
  assert.deepEqual(await run("accept"), { ok: true, value: { kind: "acceptedExistingPending" } });
  assert.deepEqual(await readdir(dir), []); assert.deepEqual([...f.rows], records); assert.deepEqual([...f.burned], burned);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});
