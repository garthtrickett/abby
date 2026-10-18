import type { OutboundLaunchHistoryResult, OutboundLaunchHistoryAuthority, OutboundLaunchHistoryQuery } from "../../src/cliniko/outbound-launch-history.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { Result } from "../../src/core/model.ts";
import type { OutboundLaunchRecordFailure, OutboundLaunchRecord, OutboundLaunchRecordQuery } from "../../src/cliniko/outbound-launch-records.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import type { NativeOutboundRetention } from "../../src/cliniko/internal/outbound-native-record.ts";
import { outboundLaunchFixture } from "./outbound-launch.ts";
import { outboundReviewDate, outboundNow } from "./outbound-records.ts";
import type { OutboundLaunchRecorderSetup } from "./outbound-record-process.ts";
type Fixture = Awaited<ReturnType<typeof outboundLaunchFixture>>;
type Outcome = Result<NativeOutboundRetention | OutboundLaunchRecord | OutboundLaunchHistoryResult, OutboundLaunchRecordFailure>;
export async function outboundLaunchPeer(f: Fixture, directory: string, options: { mode?: "retainPossible" | "readPossible" | "history"; historyAuthority?: OutboundLaunchHistoryAuthority; recallRef?: string;
  denied?: "record" | "producer"; withoutDatabase?: true; holdPostReply?: boolean; onSubmitted?(): void } = {}) {
  const child = fork(new URL("../../dist/runtime/test/support/outbound-record-process.js", import.meta.url), [], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256",...(options.withoutDatabase?{DATABASE_URL:"intentionally-not-a-database-url"}:{}) } });
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  const output: string[] = []; child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let result: Outcome | undefined, waiting: { resolve(value: Outcome): void; reject(error: Error): void } | undefined;
  const fail = () => { const e = new Error("Synthetic outbound recorder terminal"); rejectReady(e); waiting?.reject(e); };
  child.once("error", fail); child.once("exit", fail);
  const expected = outboundLaunchAttemptDigest(f.attempt), current = (q: OutboundLaunchRecordQuery) => f.authority.current(q, new AbortController().signal) === true;
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
      } else if (m.kind === "historyGrant") {
        const q = m.data as OutboundLaunchHistoryQuery, authority = options.historyAuthority;
        data = q.ownerBinding === f.binding && !!authority && authority.current(q, new AbortController().signal) === true &&
          await authority.allowsHistoryRead(q, new AbortController().signal) === true && authority.current(q, new AbortController().signal) === true;
      } else if (m.kind === "grant") {
        const grant = m.data as { purpose: "record" | "producer"; query: OutboundLaunchRecordQuery }, q = grant.query;
        const bound = q.ownerBinding === f.binding && q.patientId === f.request.patientId && q.actionRef === f.attempt.actionRef &&
          (q.attempt === undefined || q.attemptDigest === expected);
        data = bound && options.denied !== grant.purpose && current(q) && (options.mode === "history"
          ? !!options.historyAuthority && options.historyAuthority.current(q, new AbortController().signal) === true &&
            await options.historyAuthority.allowsRecordRead(q, new AbortController().signal) === true && options.historyAuthority.current(q, new AbortController().signal) === true
          : await (grant.purpose === "record" ? f.authority.allows(q, new AbortController().signal) : f.authority.producerAdmitted(q, new AbortController().signal)) === true) && current(q);
      } else if (m.kind === "claim") data = await f.config.rateBudget.claim();
      else if (m.kind === "observe429") data = await f.config.rateBudget.observe429(null);
      else throw new Error("Synthetic operation unavailable");
    } catch { data = m.kind === "fetch" ? { failed: true } : false; }
    if (child.connected) child.send({ kind: "reply", id: m.id, data });
  });
  const { rateBudget: _budget, clock: _clock, ...config } = f.config;
  const setup: OutboundLaunchRecorderSetup = { kind: "start", config, now: f.config.clock?.() ?? outboundNow,
    ...(options.mode === "history" ? {mode:"history",request:f.request,requestRecallRef:f.attempt.requestRecallRef} : options.mode === "readPossible" ?
      {mode:"readPossible",attempt:f.attempt,recallRef:options.recallRef!} : {mode:"retainPossible",attempt:f.attempt,recallAt:outboundReviewDate}) };
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
