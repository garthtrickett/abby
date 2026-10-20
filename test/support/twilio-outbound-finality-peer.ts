import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { twilioOutboundFinalityFixture } from "./twilio-outbound-finality.ts";

type Fixture = Awaited<ReturnType<typeof twilioOutboundFinalityFixture>>;
/** Parent supplies remote systems only. The child owns the actual emitted
 * adapter/native owners and its own SQL connections, physical budget and IDs. */
export async function twilioFinalityPeer(f: Fixture, cwd: string, onStoredOutcome: () => void) {
  const child = fork(new URL("./twilio-outbound-finality-worker.mjs", import.meta.url), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const output: string[] = []; child.stdout?.on("data", b => output.push(String(b))); child.stderr?.on("data", b => output.push(String(b)));
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  let failed!: (error: Error) => void; const errors = new Promise<never>((_, reject) => { failed = reject; }); errors.catch(() => {});
  child.once("error", () => failed(Error("Synthetic finality process unavailable")));
  child.on("message", async raw => {
    const m = raw as { kind: string; id: number; data: any }; let data: unknown; const signal = new AbortController().signal, p = f.finalityPorts;
    if (m.kind === "workerError" || m.kind === "result") { failed(Error("Synthetic finality ended before stored outcome boundary")); return; }
    try {
      if (m.kind === "directory") data = await f.directory[m.data.method as "findByRef" | "findByEmail"](m.data.ref);
      else if (m.kind === "definition") data = await f.definition.currentFor(m.data, signal);
      else if (m.kind === "revision") data = await f.config.stop.dnc.source.contactRevision.read(m.data);
      else if (m.kind === "grant") {
        const q = m.data.query;
        switch (m.data.family) {
          case "request": data = p.contact.stop.request.current(q, signal) && await p.contact.stop.request.allows(q, signal); break;
          case "attempt": data = p.contact.stop.attempt.current(q, signal) && await p.contact.stop.attempt.allows(q, signal); break;
          case "contact": data = p.contact.stop.contact.current(q, signal) && await p.contact.stop.contact.allows(q, signal); break;
          case "dnc": data = p.contact.stop.record.current(q, signal) && await p.contact.stop.record.allows(q, signal); break;
          case "dncProducer": data = p.contact.stop.record.current(q, signal) && await p.contact.stop.record.producerAdmitted(q, signal); break;
          case "stop": data = p.contact.stop.authority.current(q, signal) && await p.contact.stop.authority.allows(q, signal); break;
          case "outcome": data = p.contact.outcomes.current(q, signal) && await p.contact.outcomes.allows(q, signal); break;
          case "outcomeProducer": data = p.contact.outcomes.current(q, signal) && await p.contact.outcomes.producerAdmitted(q, signal); break;
          case "outcomeHistory": data = p.contact.history.current(q, signal) && await p.contact.history.allowsHistoryRead(q, signal); break;
          case "outcomeRecord": data = p.contact.history.current(q, signal) && await p.contact.history.allowsRecordRead(q, signal); break;
          case "runtimeHistory": data = p.adapter.history.current(q, signal) && await p.adapter.history.allowsHistoryRead(q, signal); break;
          case "runtimeReport": data = p.adapter.history.current(q, signal) && await p.adapter.history.allowsReportRead(q, signal); break;
          case "runtimeAttempt": data = p.adapter.history.current(q, signal) && await p.adapter.history.allowsAttemptRead(q, signal); break;
          case "closure": data = p.adapter.closure.current(q, signal) && await p.adapter.closure.allows(q, signal); break;
          case "settlement": data = p.contact.authority.current(q, signal) && await p.contact.authority.allows(q, signal); break;
          case "call": data = p.call.authority.current(q, signal) && await p.call.authority.allows(q, signal); break;
          default: throw Error("Synthetic grant unavailable");
        }
      } else if (m.kind === "nativeFetch") {
        const request = m.data, response = await p.native(request.input, { method: request.method, redirect: "error", signal, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
        const body = await response.text();
        if (request.method === "POST" && JSON.parse(request.body).recall_type_id === "63") { onStoredOutcome(); return; }
        data = { body, status: response.status, headers: Object.fromEntries(response.headers) };
      } else if (m.kind === "providerFetch") {
        const r = m.data, u = new URL(r.input), path = `/2010-04-01/Accounts/${f.carrier.accountSid}/Calls`;
        assert.equal(r.method, "GET"); assert.equal(u.origin, "https://api.twilio.com");
        assert.equal(new Headers(r.headers).get("authorization"), `Basic ${Buffer.from(`${f.carrier.accountSid}:${f.carrier.authToken}`).toString("base64")}`);
        let body: unknown;
        if (u.pathname === path + ".json") {
          assert.deepEqual(u.searchParams.getAll("ParentCallSid"), [f.callSid]); const relative = u.pathname + u.search;
          body = { calls: [], next_page_uri: null, previous_page_uri: null, page: 0, page_size: 100, uri: relative, first_page_uri: relative };
        } else {
          assert.equal(u.pathname, path + "/" + f.callSid + ".json");
          body = { account_sid: f.carrier.accountSid, sid: f.callSid, from: f.carrier.from, to: f.request.recipient.number, direction: "outbound-api", parent_call_sid: null, uri: u.pathname, status: "completed",
            date_created: new Date(f.attempt.attemptedAt).toUTCString(), start_time: "Mon, 02 Nov 2026 00:00:00 GMT", end_time: "Mon, 02 Nov 2026 00:00:02 GMT", date_updated: "Mon, 02 Nov 2026 00:00:02 GMT" };
        }
        data = { body: JSON.stringify(body), status: 200, headers: { "content-type": "application/json" } };
      } else throw Error("Synthetic operation unavailable");
    } catch { data = m.kind.endsWith("Fetch") ? { failed: true } : false; }
    if (child.connected) child.send({ kind: "reply", id: m.id, data }, () => {});
  });
  const strip = (v: object) => Object.fromEntries(Object.entries(v).filter(([key]) => !["clock", "rateBudget", "contactRevision", "now", "contextKey"].includes(key)));
  child.send({ kind: "start", data: { requests: strip(f.config.stop.requests), attempts: strip(f.config.stop.attempts), reports: strip(f.reports), contact: strip(f.config.stop.dnc.source), outcomes: strip(f.finalityConfig.contact.outcomes),
    accountPath: f.captureConfig.path, policyPath: f.policyPath, automationPrincipalRef: f.config.stop.dnc.automationPrincipalRef, guardRef: f.guardRef, campaignRef: f.attempt.campaignRef,
    carrier: strip(f.carrier), contextKey: Buffer.from(f.carrier.contextKey).toString("base64"), reportKey: Buffer.from(f.key).toString("base64"), now: f.state.now,
    binding: { recallRef: f.original().original.recallRef, actionRef: f.attempt.actionRef, patientId: f.attempt.patientId } } });
  return { output, errors, async kill() { if (child.exitCode === null && child.signalCode === null) { assert.ok(child.kill("SIGKILL")); assert.equal(await terminal, "SIGKILL"); } } };
}
