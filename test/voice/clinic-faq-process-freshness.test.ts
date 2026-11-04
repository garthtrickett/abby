import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicInformationUnavailable } from "../../src/core/public-information.ts";
import { clinicFAQFixture, publicDirections } from "../support/clinic-faqs.ts";
import type { FAQProcessConfig, FAQProcessRead, FAQProcessRequest } from "../support/clinic-faq-process-worker.ts";

function worker() {
  const child = fork(fileURLToPath(new URL("../support/clinic-faq-process-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", new URL("../../scripts/test-typescript-loader.mjs", import.meta.url).href],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let sequence = 0, diagnostics = "";
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4_000); });
  const fail = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", error => { fail(error); reject(error); });
    child.once("exit", (code, signal) => {
      const error = new Error(`FAQ worker exited (${code ?? signal}): ${diagnostics}`); fail(error);
      code === 0 ? resolve() : reject(error);
    });
  });
  void done.catch(() => {});
  child.on("message", (message: { id: number; result?: unknown; error?: string }) => {
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
  });
  const request = <T>(request: FAQProcessRequest) => new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    // Loading the full source graph happens once in each child. Keep that
    // startup budget distinct from the bounded already-running owner reads.
    const timeout = request.op === "init" ? 45_000 : 15_000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`FAQ worker request ${request.op} timed out: ${diagnostics}`)); }, timeout);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    child.send({ id, request }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
  return { request, async close() {
    if (child.exitCode === null && child.signalCode === null) {
      try { await request({ op: "close" }); }
      finally { if (child.connected) child.disconnect(); }
    }
    await done;
  }, async stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await done.catch(() => {});
  } };
}

test("public FAQ edits and revocation reach separate voice-selector and agent processes without restarting them", { timeout: 90_000 }, async () => {
  const f = await clinicFAQFixture();
  const voice = worker(), agent = worker();
  const unavailable = { text: "I can't verify that information right now.", accepted: false };
  const feeUnavailable = { text: publicInformationUnavailable("priceAndFees"), accepted: false };
  const answer = (sourceRef: string, text: string) => agent.request({ op: "answer", sourceRef, text });
  const read = () => voice.request<FAQProcessRead>({ op: "read" });
  const fresh = () => Promise.all([voice.request<FAQProcessRead>({ op: "fresh" }), agent.request<FAQProcessRead>({ op: "fresh" })]);
  try {
    const config: FAQProcessConfig = { scope: f.scope, faqPath: f.faqPath, accountPath: f.accountPath, policyVersion: f.flowConfig.policyVersion };
    const initial = await Promise.all([voice.request<FAQProcessRead>({ op: "init", config }), agent.request<FAQProcessRead>({ op: "init", config })]);
    assert.notEqual(initial[0]!.pid, initial[1]!.pid); assert.notEqual(initial[0]!.pid, process.pid);
    assert.ok(initial.every(result => result.choices.some(fact => fact.approvedText === publicDirections)), "both workers must start with the actual admitted public facts");
    const pids = initial.map(result => result.pid), oldVersion = initial[0]!.choices[0]!.version;
    assert.deepEqual(await answer("clinic-public-directionsAndParking", publicDirections), { text: publicDirections, accepted: true });

    const price = "The published consultation fee is AUD 99.50.", contact = "The public clinic number is 02 5550 0123.";
    const replacement = [{ topic: "priceAndFees" as const, approvedText: price }, { topic: "contact" as const, approvedText: contact }];
    const revision = f.faqApproval.revision;
    await f.replaceFAQs({ facts: replacement });
    assert.equal(f.faqApproval.revision, revision, "content changes must invalidate snapshots even with a reused revision label");
    assert.deepEqual((await read()).choices, []);
    assert.deepEqual(await answer("clinic-public-directionsAndParking", publicDirections), unavailable);
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), feeUnavailable, "an old call cannot adopt a newly approved answer");
    const updated = await fresh();
    assert.deepEqual(updated.map(result => result.pid), pids, "fresh calls must use the original long-lived processes");
    assert.ok(updated.every(result => result.choices.length === 2 && result.choices.every(fact => fact.version !== oldVersion)));
    assert.deepEqual(updated[0]!.choices.map(fact => fact.approvedText), [contact, price]);
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), { text: price, accepted: true });

    await f.replaceFAQs({ facts: [...replacement].reverse() });
    assert.deepEqual((await read()).choices, [], "reordering also changes the whole approved content binding");
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), feeUnavailable);
    await fresh(); assert.deepEqual((await read()).choices.map(fact => fact.approvedText), [contact, price]);
    await f.replaceFAQs({ facts: [replacement[0]!] });
    assert.deepEqual((await read()).choices, []); await fresh();
    assert.deepEqual((await read()).choices.map(fact => fact.approvedText), [price]);
    assert.deepEqual(await answer("clinic-public-contact", contact), unavailable, "a removed fact cannot become a retained answer");
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), { text: price, accepted: true });

    await f.replaceFAQs({ approved: false });
    assert.deepEqual(await read(), { pid: pids[0], choices: [], readKind: "ok" });
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), feeUnavailable);
    await writeFile(f.faqPath, "{malformed", { mode: 0o600 });
    assert.deepEqual(await read(), { pid: pids[0], choices: [], readKind: "unavailable" });
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), feeUnavailable);
    await f.replaceFAQs({ approved: true }); await fresh(); await chmod(f.faqPath, 0o644);
    assert.deepEqual(await read(), { pid: pids[0], choices: [], readKind: "unavailable" });
    assert.deepEqual(await answer("clinic-public-priceAndFees", price), feeUnavailable);
    assert.equal(f.posts, 0); assert.equal(f.mail.length, 0);
  } finally {
    const cleanup = await Promise.allSettled([voice.close(), agent.close()]);
    await Promise.all([voice.stop(), agent.stop()]);
    await f.close();
    const failed = cleanup.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "FAQ worker cleanup failed");
  }
});
