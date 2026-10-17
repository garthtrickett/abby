import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { Result } from "../../src/core/model.ts";
import type { OutboundRecordFailure, OutboundRecipientRecord, OutboundRecordRetention, OutboundRecordQuery } from "../../src/cliniko/outbound-recipient-records.ts";
import { outboundRecipientRequestDigest } from "../../src/cliniko/outbound-recipient-request.ts";
import { outboundRecordsFixture, outboundReviewDate, outboundNow } from "./outbound-records.ts";
import type { OutboundRecorderSetup } from "./outbound-record-process.ts";
type Fixture = Awaited<ReturnType<typeof outboundRecordsFixture>>;
type Outcome = Result<OutboundRecordRetention | OutboundRecipientRecord, OutboundRecordFailure>;
export async function outboundRecordPeer(f: Fixture, directory: string, options: { mode?: "retain" | "read"; recallRef?: string;
  denied?: "record" | "producer"; holdPostReply?: boolean; onSubmitted?(): void } = {}) {
  const child = fork(new URL("../../dist/runtime/test/support/outbound-record-process.js", import.meta.url), [], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  const output: string[] = []; child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let result: Outcome | undefined, waiting: { resolve(value: Outcome): void; reject(error: Error): void } | undefined;
  const fail = () => { const e = new Error("Synthetic outbound recorder terminal"); rejectReady(e); waiting?.reject(e); };
  child.once("error", fail); child.once("exit", fail);
  const expected = outboundRecipientRequestDigest(f.request), current = (q: OutboundRecordQuery) => f.authority.current(q, new AbortController().signal) === true;
  child.on("message", async (raw: unknown) => {
    const m = raw as { kind: string; id: number; data: unknown };
    if (m.kind === "ready") { resolveReady(); return; }
    if (m.kind === "result") { if (waiting) { const next = waiting; waiting = undefined; next.resolve(m.data as Outcome); } else result = m.data as Outcome; return; }
    if (m.kind === "workerError") { fail(); return; }
    let data: unknown;
    try {
      if (m.kind === "fetch") {
        const request = m.data as { input: string; method: string; body?: string; headers: Record<string, string> };
        const response = await f.port(request.input, { method: request.method, headers: request.headers, redirect: "error", signal: AbortSignal.timeout(30000),
          ...(request.body === undefined ? {} : { body: request.body }) });
        if (request.method === "POST" && options.holdPostReply) { options.onSubmitted?.(); return; }
        data = { status: response.status, body: await response.text() };
      } else if (m.kind === "grant") {
        const grant = m.data as { purpose: "record" | "producer"; query: OutboundRecordQuery }, q = grant.query;
        const bound = q.ownerBinding === f.binding && q.patientId === f.request.patientId && q.actionRef === f.request.actionRef &&
          (q.request === undefined || q.requestDigest === expected);
        data = bound && options.denied !== grant.purpose && current(q) && await (grant.purpose === "record" ? f.authority.allows(q, new AbortController().signal) : f.authority.producerAdmitted(q, new AbortController().signal)) === true && current(q);
      } else if (m.kind === "claim") data = await f.config.rateBudget.claim();
      else if (m.kind === "observe429") data = await f.config.rateBudget.observe429(null);
      else throw new Error("Synthetic operation unavailable");
    } catch { data = m.kind === "fetch" ? { failed: true } : false; }
    if (child.connected) child.send({ kind: "reply", id: m.id, data });
  });
  const { rateBudget: _budget, clock: _clock, ...config } = f.config;
  const setup: OutboundRecorderSetup = { kind: "start", config, request: f.request, now: f.config.clock?.() ?? outboundNow,
    ...(options.mode === "read" ? { mode: "read", recallRef: options.recallRef! } : { mode: "retain", recallAt: outboundReviewDate }) };
  child.send(setup);
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { assert.equal(child.kill("SIGKILL"), true); assert.equal(await terminal, "SIGKILL"); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic recorder ready deadline")), 10000); })]); }
  catch (e) { await kill(); throw e; } finally { if (timer) clearTimeout(timer); }
  const nextResult = async () => {
    if (result) { const found = result; result = undefined; return found; }
    assert.equal(waiting, undefined);
    return new Promise<Outcome>((resolve, reject) => {
      const timeout = setTimeout(() => { waiting = undefined; reject(new Error("Synthetic recorder result deadline")); }, 20000);
      waiting = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: e => { clearTimeout(timeout); reject(e); } };
    });
  };
  return { child, output, kill, nextResult };
}
