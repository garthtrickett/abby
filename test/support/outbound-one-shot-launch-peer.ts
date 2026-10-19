import assert from "node:assert/strict";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { value } from "./outbound-records.ts";
import { dirname, join } from "node:path";
import { fork } from "node:child_process";
import type { outboundLaunchOwnerFixture } from "./outbound-launch-owner.ts";
import type { OutboundTargetAuthority } from "../../src/cliniko/outbound-appointment-target.ts";
import type { OutboundLaunchAuthority } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
type Fixture = Awaited<ReturnType<typeof outboundLaunchOwnerFixture>>;
export async function outboundLaunchPeer(f: Fixture, cwd: string, onSubmitted: () => void, hold: "nativeAck" | "provider",
  targeted?: Readonly<{ individualTarget: Readonly<{ appointmentPolicyDigest: string }>; target: OutboundTargetAuthority;
    authority: OutboundLaunchAuthority; native: typeof fetch }>) {
  const child = fork(new URL("./outbound-launch-worker.mjs", import.meta.url), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const output: string[] = []; child.stdout?.on("data", value => output.push(String(value))); child.stderr?.on("data", value => output.push(String(value)));
  const terminal = new Promise<NodeJS.Signals | null>(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  let failed!: (error: Error) => void;
  const errors = new Promise<never>((_, reject) => { failed = reject; }); errors.catch(() => {});
  child.once("error", () => failed(new Error("Synthetic owner process unavailable")));
  child.on("message", async raw => {
    const m = raw as { kind: string; id: number; data: any }; let data: unknown;
    if (m.kind === "workerError" || m.kind === "result") { failed(new Error("Synthetic owner ended before held dispatch")); return; }
    try {
      if (m.kind === "directory") data = await f.directory[m.data.method as "findByRef" | "findByEmail"](m.data.ref);
      else if (m.kind === "definition") data = await f.definition.currentFor(m.data, new AbortController().signal);
      else if (m.kind === "revision") data = await f.config.contact.contactRevision.read(m.data);
      else if (m.kind === "fetch") {
        const request = m.data;
        const response = await (targeted?.native ?? f.native)(request.input, { method: request.method, headers: request.headers, redirect: "error", signal: AbortSignal.timeout(15000),
          ...(request.body === undefined ? {} : { body: request.body }) });
        if (hold === "nativeAck" && request.method === "POST") { onSubmitted(); return; }
        data = { body: await response.text(), status: response.status };
      } else if (m.kind === "provider") {
        const allocation = value(decodeOutboundLaunchAttempt(f.contactControls.rows.find(r =>
          (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!.notes)).capacityAllocationRef;
        assert.ok(allocation, "a provider dispatch must have an exact v2 native allocation binding");
        assert.deepEqual(m.data, { effectRef: f.request.effectRef, capacityAllocationRef: allocation,
          number: f.request.recipient.number, profileRef: f.ports.provider.binding().profileRef });
        f.calls.push(m.data); if (hold === "provider") { onSubmitted(); return; }
        data = { kind: "accepted", effectRef: f.request.effectRef };
      } else if (m.kind === "grant") {
        const { family, query } = m.data, signal = new AbortController().signal;
        if (family === "request") data = f.ports.request.current(query, signal) && await f.ports.request.allows(query, signal);
        else if (family === "attempt") data = f.ports.attempt.current(query, signal) && await f.ports.attempt.allows(query, signal);
        else if (family === "attemptProducer") data = f.ports.attempt.current(query, signal) && await f.ports.attempt.producerAdmitted(query, signal);
        else if (family === "history") data = f.ports.history.current(query, signal) && await f.ports.history.allowsHistoryRead(query, signal);
        else if (family === "historyRecord") data = f.ports.history.current(query, signal) && await f.ports.history.allowsRecordRead(query, signal);
        else if (family === "contact") data = f.ports.contact.current(query, signal) && await f.ports.contact.allows(query, signal);
        else if (family === "authority") { const authority = targeted?.authority ?? f.ports.authority; data = authority.current(query, signal) && await authority.allows(query, signal); }
        else if (family === "target" && targeted) data = targeted.target.current(query, signal) && await targeted.target.allows(query, signal);
        else throw new Error("Synthetic grant unavailable");
      } else throw new Error("Synthetic operation unavailable");
    } catch { data = m.kind === "fetch" ? { failed: true } : false; }
    if (child.connected) child.send({ kind: "reply", id: m.id, data });
  });
  const { clock: _clock, rateBudget: _budget, ...requests } = f.config.requests;
  const { clock: _attemptClock, rateBudget: _attemptBudget, ...attempts } = f.config.attempts;
  const { clock: _contactClock, rateBudget: _contactBudget, contactRevision: _revision, ...contact } = f.config.contact;
  child.send({ kind: "start", data: { requests, attempts, contact, campaignRef: f.request.campaignRef,
    ...(targeted ? { individualTarget: targeted.individualTarget } : {}),
    campaignPath: join(dirname(f.definitionConfig.path), "campaign.json"), now: f.state.now, provider: f.ports.provider.binding(), binding: f.binding } });
  return { child, output, errors,
    async kill() { if (child.exitCode === null && child.signalCode === null) { assert.ok(child.kill("SIGKILL")); assert.equal(await terminal, "SIGKILL"); } } };
}
