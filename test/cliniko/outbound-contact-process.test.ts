import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { outboundContactSourceFixture } from "../support/outbound-contact-source.ts";
import type { ContactProcessSetup } from "../support/outbound-contact-process.ts";
import type { OutboundContactQuery } from "../../src/cliniko/outbound-contact-source.ts";
import { value } from "../support/outbound-records.ts";
type Fixture = Awaited<ReturnType<typeof outboundContactSourceFixture>>;
async function compiled(f: Fixture) {
  const directory = await mkdtemp(join(tmpdir(), "abby-contact-worker-"));
  const child = fork(new URL("../../dist/runtime/test/support/outbound-contact-process.js", import.meta.url), [], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256", DATABASE_URL: "intentionally-not-a-database-url" } });
  const exited = once(child, "exit"), output: string[] = []; child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = new Promise<Awaited<ReturnType<Fixture["read"]>>>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic compiled contact read deadline")), 25000);
    child.once("error", reject);
    child.on("message", async (raw: unknown) => {
      const m = raw as { kind: string; id: number; data: unknown };
      if (m.kind === "result") { resolve(m.data as Awaited<ReturnType<Fixture["read"]>>); return; }
      if (m.kind === "workerError") { reject(new Error("Synthetic contact read failed")); return; }
      let data: unknown;
      try {
        if (m.kind === "membership") data = await f.directory.findByRef(String(m.data));
        else if (m.kind === "emailMembership") data = await f.directory.findByEmail(String(m.data));
        else if (m.kind === "revision") data = await f.config.contactRevision.read(String(m.data));
        else if (m.kind === "claim") data = await f.config.rateBudget.claim();
        else if (m.kind === "observe429") data = await f.config.rateBudget.observe429(null);
        else if (m.kind === "grant") {
          const q = m.data as OutboundContactQuery;
          data = f.authority.current(q, new AbortController().signal) === true && await f.authority.allows(q, new AbortController().signal) === true &&
            f.authority.current(q, new AbortController().signal) === true;
        } else if (m.kind === "fetch") {
          const request = m.data as { input: string; method: string; body?: string; headers: Record<string, string> };
          const response = await f.port(request.input, { method: request.method, headers: request.headers, redirect: "error", signal: AbortSignal.timeout(15000),
            ...(request.body === undefined ? {} : { body: request.body }) });
          data = { status: response.status, body: await response.text() };
        } else throw new Error("Synthetic IPC unavailable");
      } catch { data = m.kind === "fetch" ? { failed: true } : false; }
      if (child.connected) child.send({ kind: "reply", id: m.id, data });
    });
  });
  const { rateBudget: _, clock: _clock, contactRevision: _revision, ...config } = f.config;
  const setup: ContactProcessSetup = { kind: "start", config, request: f.request, sourcePath: f.definitionConfig.path, now: f.state.now }; child.send(setup);
  try {
    const found = await outcome;
    assert.deepEqual(await exited, [0, null], "compiled read closes cleanly"); assert.deepEqual(output, []);
    assert.deepEqual(await readdir(directory), [], "no patient-bearing payload files or local cache"); return found;
  } finally {
    if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
test("compiled native contact read uses actual owner-file membership and no database or email", { timeout: 30000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const found = value(await compiled(f));
  assert.equal(found.disposition, "eligibleEvidence"); assert.equal(found.head?.review.actionRef, f.first.actionRef); assert.equal(f.state.claims, f.calls.length);
});
test("compiled archived closed DNC survives native history without patient-bearing local state", { timeout: 30000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const stop = f.next(f.first, { doNotCall: "blocked" });
  f.controls.rows = [f.row(f.first), { ...f.row(stop, "102"), recalled: true, recalled_at: "2026-11-01T00:00:00.000Z", archived_at: "2026-11-01T00:00:00.000Z" }];
  assert.equal(value(await compiled(f)).disposition, "blocked");
});
test("compiled independent head denial cannot disclose an affirmative contact result", { timeout: 30000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); f.controls.allow = q => q.operation !== "approveContactHead";
  assert.deepEqual(await compiled(f), { ok: false, error: { kind: "forbidden" } });
});
test("compiled maximum native history stays within actual unchanged180 physical budget", { timeout: 30000 }, async t => {
  const f = await outboundContactSourceFixture(); t.after(f.close); const reviews = [f.first];
  for (let i = 1; i < 50; i++) reviews.push(f.next(reviews.at(-1)!));
  f.controls.rows = Array.from({ length: 500 }, (_, i) => {
    if (i >= 450) return f.row(reviews[i - 450]!, String(100 + i));
    return { ...f.row(f.first, String(100 + i)), notes: "Unrelated native review", recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/92" } } };
  });
  const found = value(await compiled(f)); assert.equal(found.disposition, "eligibleEvidence"); assert.equal(found.head?.review.revision, 50);
  assert.equal(f.state.claims, 62); assert.equal(f.state.claims, f.calls.length);
});
