import { randomBytes } from "node:crypto";
import { openSync, closeSync, writeFileSync, renameSync } from "node:fs";
import { once } from "node:events";
import { resolve, dirname } from "node:path";
import { TwilioVoiceRehearsal } from "../src/testing/twilio-voice-rehearsal.ts";
import { createRehearsalServer } from "../src/testing/twilio-rehearsal-server.ts";
import { ownedBodyBytes } from "../src/shared/owned-body-bytes.ts";
import { rehearsalCarrier, runRehearsal } from "../src/testing/twilio-rehearsal-run.ts";

async function main() {
  const [mode, output] = process.argv.slice(2);
  if (!["--dry-run", "--preflight", "--execute"].includes(mode ?? "") || process.argv.length > 4 ||
      (mode === "--execute" && !output)) throw Error("Invalid rehearsal arguments");
  const e = process.env;
  if (e.ABBY_VOICE_TEST_MODE !== "1") throw Error("Rehearsal requires an explicitly isolated test route");
  const from = e.ABBY_TWILIO_TEST_CALLER_NUMBER ?? "", to = e.ABBY_TWILIO_TEST_NUMBER ?? "";
  const callbackBase = e.ABBY_REHEARSAL_CALLBACK_BASE ?? "";
  const runId = randomBytes(16).toString("hex");
  const rehearsal = new TwilioVoiceRehearsal({ accountSid: e.ABBY_TWILIO_ACCOUNT_SID ?? "",
    authToken: e.ABBY_TWILIO_AUTH_TOKEN ?? "", from, to, callbackBase, runId, expiresAt: Date.now() + 300_000 });
  const plan = { scenario: rehearsal.summary().scenario, mode, calls: 1, maxConnectedSeconds: 180,
    callerSuffix: from.slice(-4), destinationSuffix: to.slice(-4), callbackOrigin: new URL(callbackBase).origin,
    scenarios: ["greeting", "hello", "blue", "green"], conversationRuntime: "Twilio Say/Gather; no Vapi",
    interruption: "notRun", fallbackRinging: "notRun", clinicalAcceptance: false };
  if (mode === "--dry-run") { console.log(JSON.stringify(plan)); return; }
  const carrier = rehearsalCarrier(e.ABBY_TWILIO_ACCOUNT_SID!, e.ABBY_TWILIO_AUTH_TOKEN!, from, to);
  if (mode === "--preflight") {
    const callerEligible = await carrier.eligibleCaller();
    console.log(JSON.stringify({ ...plan, callerEligible, callsPlaced: 0 }));
    if (!callerEligible) process.exitCode = 2;
    return;
  }
  if (!await carrier.eligibleCaller()) throw Error("Test caller is not eligible");
  const port = Number(e.ABBY_REHEARSAL_PORT ?? "3121");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error("Invalid rehearsal port");
  const path = resolve(output!);
  // An existing journal prevents a second physical launch after a restart.
  closeSync(openSync(path, "wx", 0o600));
  let callSid: string | undefined;
  const save = (receipt: unknown) => {
    if (receipt && typeof receipt === "object" && "callSid" in receipt && typeof receipt.callSid === "string") callSid = receipt.callSid;
    const tmp = resolve(dirname(path), `.${runId}.tmp`);
    writeFileSync(tmp, JSON.stringify({ runId, at: new Date().toISOString(), ...plan, callSid, receipt }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  };
  save({ phase: "prepared" });
  const server = createRehearsalServer(rehearsal, () => save({ phase: "callback", summary: rehearsal.summary() }), runId);
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const response = await fetch(new URL("/healthz", callbackBase), { signal, redirect: "error" });
    if (response.status !== 200 || new TextDecoder().decode(await ownedBodyBytes(response.body, 128, signal)) !== runId)
      throw Error("Public callback route does not reach this caller");
    const summary = await runRehearsal(rehearsal, carrier, save, { signal: controller.signal });
    console.log(JSON.stringify(summary));
    if (!summary.carrierDialoguePassed) process.exitCode = 1;
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
  }
}
main().catch(() => { console.error("Voice rehearsal unavailable; check private configuration/journal. No automatic launch retry."); process.exitCode = 1; });
