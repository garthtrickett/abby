import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ownedBodyBytes } from "../src/shared/owned-body-bytes.ts";
import { rehearsalCarrier, runRehearsal } from "../src/testing/twilio-rehearsal-run.ts";
import { createRehearsalServer } from "../src/testing/twilio-rehearsal-server.ts";
import { createRehearsalListenerSocket } from "../src/testing/twilio-rehearsal-listener-socket.ts";
import { TwilioRehearsalFallback } from "../src/testing/twilio-rehearsal-fallback.ts";
import { rehearsalLegObserver } from "../src/testing/twilio-rehearsal-legs.ts";
import { rehearsalTargetSnapshot } from "../src/testing/twilio-rehearsal-observation.ts";
import { observeRehearsalCarrier } from "../src/testing/twilio-rehearsal-carrier-observation.ts";
import { TwilioVoiceRehearsal } from "../src/testing/twilio-voice-rehearsal.ts";
import type { RehearsalScenario } from "../src/testing/twilio-voice-rehearsal.ts";

/** Restricted test-only runner. One create intent, one caller, one target session.
 * Report and REST reads may retry; an uncertain create never does. */
async function main() {
  const [mode, scenario, journalName, reportName] = process.argv.slice(2);
  if (!["--dry-run", "--preflight", "--execute"].includes(mode ?? "") ||
      !["dialogue", "interruption", "fallback"].includes(scenario ?? "") || process.argv.length > 6 ||
      (mode === "--execute" && (!journalName || !reportName))) throw Error("Invalid probe arguments");
  const e = process.env;
  if (e.ABBY_VOICE_TEST_MODE !== "1") throw Error("Isolated voice test mode required");
  const accountSid = e.ABBY_TWILIO_ACCOUNT_SID ?? "", authToken = e.ABBY_TWILIO_AUTH_TOKEN ?? "";
  const caller = e.ABBY_TWILIO_TEST_CALLER_NUMBER ?? "", number = e.ABBY_TWILIO_TEST_NUMBER ?? "";
  const fallbackNumber = e.ABBY_TWILIO_FALLBACK_NUMBER ?? "";
  if (!/^\+[1-9]\d{7,14}$/.test(fallbackNumber) ||
      new Set([caller, number, fallbackNumber]).size !== 3) throw Error("Distinct approved test numbers required");
  const callbackBase = e.ABBY_REHEARSAL_CALLBACK_BASE ?? "";
  const fallbackUrl = e.ABBY_REHEARSAL_FALLBACK_CALLBACK_URL ?? "";
  const expectedFallbackBase = new URL(callbackBase);
  const configuredFallback = scenario === "fallback" ? new URL(fallbackUrl) : undefined;
  if (configuredFallback && configuredFallback.origin !== expectedFallbackBase.origin)
    throw Error("Fallback callback must reach this caller listener");
  const runId = configuredFallback?.pathname.match(/^\/fallback-ringing\/([a-f0-9]{32})$/)?.[1] ??
    (scenario === "fallback" ? "" : randomBytes(16).toString("hex"));
  if (!runId || configuredFallback && configuredFallback.href !== new URL(`/fallback-ringing/${runId}`, expectedFallbackBase).href)
    throw Error("Invalid fallback callback route");
  const expiresAt = Date.now() + 300_000;
  const listenerUrl = scenario === "interruption" ? new URL(`/voice-rehearsal-media/${runId}`, expectedFallbackBase) : undefined;
  if (listenerUrl) listenerUrl.protocol = "wss:";
  const rehearsal = new TwilioVoiceRehearsal({ accountSid, authToken, from: caller, to: number,
    callbackBase, runId, expiresAt, scenario: scenario as RehearsalScenario,
    ...(listenerUrl ? { listenerStreamUrl: listenerUrl.href } : {}) });
  const fallbackEvents = configuredFallback && new TwilioRehearsalFallback({ accountSid, authToken,
    callbackUrl: configuredFallback.href, fallback: fallbackNumber, expiresAt });
  const plan = { mode, scenario, calls: 1, maxConnectedSeconds: 180,
    callerSuffix: caller.slice(-4), destinationSuffix: number.slice(-4),
    fallbackSuffix: fallbackNumber.slice(-4), callbackOrigin: expectedFallbackBase.origin,
    clinicalAcceptance: false, speechQualificationPassed: false, recordingEnabled: false,
    listenerMediaEnabled: Boolean(listenerUrl) };
  if (mode === "--dry-run") { console.log(JSON.stringify(plan)); return; }
  const carrier = rehearsalCarrier(accountSid, authToken, caller, number);
  if (mode === "--preflight") {
    const eligible = await carrier.eligibleCaller();
    console.log(JSON.stringify({ ...plan, callerEligible: eligible, callsPlaced: 0 }));
    if (!eligible) process.exitCode = 2;
    return;
  }
  const port = Number(e.ABBY_REHEARSAL_PORT ?? "3121");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !await carrier.eligibleCaller())
    throw Error("Probe route or caller is unavailable");
  const listener = listenerUrl && createRehearsalListenerSocket({ accountSid, authToken,
    runId, publicUrl: listenerUrl.href, expiresAt });
  const reportPath = resolve(reportName!), journal = resolve(journalName!);
  const readTarget = () => rehearsalTargetSnapshot(JSON.parse(readFileSync(reportPath, "utf8")), Date.now());
  const before = readTarget();
  if (before.active || before.total >= 6 || before.expiresAt <= Date.now() + 240_000)
    throw Error("Restricted target has no safe call window");
  const observer = rehearsalLegObserver(accountSid, authToken);
  // Exclusive journal creation occurs before a listener or provider create.
  closeSync(openSync(journal, "wx", 0o600));
  let callSid: string | undefined;
  const save = (receipt: unknown) => {
    if (receipt && typeof receipt === "object" && "callSid" in receipt && typeof receipt.callSid === "string")
      callSid = receipt.callSid;
    const temporary = resolve(dirname(journal), `.${runId}.tmp`);
    writeFileSync(temporary, JSON.stringify({ runId, at: new Date().toISOString(), ...plan, callSid, receipt }) + "\n", { mode: 0o600 });
    renameSync(temporary, journal);
  };
  save({ phase: "prepared", targetRunId: before.runId, targetTotal: before.total });
  const server = createRehearsalServer(rehearsal, () => save({ phase: "callback", summary: rehearsal.summary() }),
    runId, fallbackEvents ? { path: configuredFallback!.pathname, accept: request => fallbackEvents.accept(request) } : undefined,
    listener);
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const health = await fetch(new URL("/healthz", callbackBase), { signal, redirect: "error" });
    if (health.status !== 200 || new TextDecoder().decode(await ownedBodyBytes(health.body, 128, signal)) !== runId)
      throw Error("Public callback route does not reach this listener");
    const launchedAt = Date.now();
    const callerSummary = await runRehearsal(rehearsal, carrier, save, { signal: controller.signal });
    if (!callSid || !/^CA[0-9a-f]{32}$/.test(callSid)) throw Error("Exact caller identity unavailable");
    listener?.bindCall(callSid);
    // Target's asynchronous stream cleanup may lag the caller terminal. Reads
    // are bounded and cannot place a second call or invent a missing event.
    let after = readTarget();
    for (let index = 0; index < 12 && !controller.signal.aborted &&
         (after.total !== before.total + 1 || after.active !== 0); index++) {
      await delay(1_000); after = readTarget();
    }
    const targetSid = after.latest?.callSid;
    if (!targetSid) throw Error("Exact target identity unavailable");
    fallbackEvents?.bindTarget(targetSid);
    const { result, observation } = await observeRehearsalCarrier({ accountSid, caller, number,
      fallback: fallbackNumber, scenario: scenario as RehearsalScenario }, {
      callerSid: callSid, launchedAt, caller: callerSummary, before, after,
      ...(fallbackEvents ? { fallbackEvents } : {}) }, observer, { signal: controller.signal });
    if (controller.signal.aborted) throw Error("Carrier observation canceled");
    // The fork is diagnostic. Transport playback and this metadata remain
    // independent; neither may silently upgrade the audible-interruption gate.
    const listenerObservation = listener ? await listener.waitForTerminal(5_000) : undefined;
    save({ phase: "qualified", result, observation, listener: listenerObservation });
    console.log(JSON.stringify(result));
    if (!result.carrierScenarioPassed) process.exitCode = 1;
  } finally {
    listener?.close();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
  }
}
main().catch(() => { console.error("Carrier probe unavailable; inspect private journal. No automatic call retry."); process.exitCode = 1; });
