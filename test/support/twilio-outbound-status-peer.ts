import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { twilioOutboundStatusVoiceFixture } from "./twilio-outbound-status-voice.ts";

type Fixture = Awaited<ReturnType<typeof twilioOutboundStatusVoiceFixture>>;
type Boundary = Readonly<{ family: "91" | "66"; stored: boolean; reached: () => void }>;
/** Clinic config enters at boot; the provider's signed request enters by HTTP.
 * The parent supplies only synthetic remote/native grants, never recovery. */
export async function twilioStatusPeer(f: Fixture, cwd: string, boundary?: Boundary) {
  const child = fork(new URL("./twilio-outbound-status-worker.mjs", import.meta.url), [], {
    cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" }
  });
  const output: string[] = []; child.stdout?.on("data", b => output.push(String(b))); child.stderr?.on("data", b => output.push(String(b)));
  const terminal = new Promise<readonly [number | null, NodeJS.Signals | null]>(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
  let ready!: (port: number) => void, failed!: (error: Error) => void;
  const listening = new Promise<number>(resolve => { ready = resolve; });
  const errors = new Promise<never>((_, reject) => { failed = reject; }); errors.catch(() => {});
  child.once("error", () => failed(Error("Synthetic callback worker unavailable")));
  child.once("exit", () => failed(Error("Synthetic callback worker exited")));
  child.on("message", async raw => {
    const m = raw as { kind: string; id: number; port?: number; data: any };
    if (m.kind === "listening") { ready(m.port!); return; }
    if (m.kind === "workerError") { failed(Error("Synthetic callback capture failed")); return; }
    const signal = new AbortController().signal, p = f.statusConfig.stop.ports, n = f.statusConfig.notifications.ports;
    let data: unknown;
    try {
      if (m.kind === "directory") data = await f.directory[m.data.method as "findByRef" | "findByEmail"](m.data.ref);
      else if (m.kind === "definition") data = await p.definition.currentFor(m.data, signal);
      else if (m.kind === "revision") data = await f.config.stop.dnc.source.contactRevision.read(m.data);
      else if (m.kind === "source") data = n.source.current() ? await n.source.read() : { ok: false, error: { kind: "unavailable" } };
      else if (m.kind === "grant") {
        const { family, method, query } = m.data;
        const authorities: Record<string, any> = { request: p.request, attempt: p.attempt, contact: p.contact, record: p.record,
          authority: p.authority, reports: p.reports, notificationRecord: n.record, notificationHistory: n.history,
          ingress: { allows: async () => f.notificationState.ingress, current: () => f.notificationState.ingress } };
        const authority = authorities[family]; assert.ok(authority && typeof authority[method] === "function");
        data = authority.current(query, signal) && await authority[method](query, signal);
      } else if (m.kind === "native") {
        const r = m.data, family = r.method === "POST" ? JSON.parse(r.body).recall_type_id : undefined;
        if (boundary && family === boundary.family && !boundary.stored) { boundary.reached(); return; }
        const response = await n.native!(r.input, { method: r.method, redirect: "error", signal, headers: r.headers,
          ...(r.body === undefined ? {} : { body: r.body }) });
        const body = await response.text();
        if (boundary && family === boundary.family && boundary.stored) { boundary.reached(); return; }
        data = { body, status: response.status, headers: Object.fromEntries(response.headers) };
      } else throw Error("Synthetic callback operation unavailable");
    } catch { data = m.kind === "native" ? { failed: true } : false; }
    if (child.connected) child.send({ kind: "reply", id: m.id, data }, () => {});
  });
  const strip = (v: object) => Object.fromEntries(Object.entries(v).filter(([key]) => !["clock", "rateBudget", "contactRevision", "now", "contextKey"].includes(key)));
  child.send({ kind: "start", data: { requests: strip(f.config.stop.requests), attempts: strip(f.config.stop.attempts),
    reports: strip(f.reports), contact: strip(f.config.stop.dnc.source), observations: strip(f.statusConfig.notifications.config.observations),
    policyPath: f.policyPath, automationPrincipalRef: f.config.stop.dnc.automationPrincipalRef, carrier: strip(f.carrier),
    contextKey: f.carrier.contextKey.toString("base64"), reportKey: f.key.toString("base64"), notificationKey: f.notificationKey.toString("base64"), now: f.state.now } });
  let timer: ReturnType<typeof setTimeout>;
  const started = Promise.race([listening, errors, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error("Synthetic callback worker did not listen")), 10000);
  })]);
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) { assert.ok(child.kill("SIGKILL")); assert.deepEqual(await terminal, [null, "SIGKILL"]); }
  };
  try {
    const port = await started;
    return { output, errors, kill,
      async close() { if (child.connected) child.send({ kind: "close" }); assert.deepEqual(await terminal, [0, null]); },
      async send() {
        const r = f.statusRequest();
        const response = await fetch(`http://127.0.0.1:${port}${r.requestTarget}`, { method: r.method, headers: {
          "content-type": r.contentType, "x-twilio-signature": r.signature }, body: r.body, signal: AbortSignal.timeout(10000) });
        assert.equal(await response.text(), ""); return response.status;
      }
    };
  } catch (error) { await kill(); throw error; }
  finally { clearTimeout(timer!); }
}
