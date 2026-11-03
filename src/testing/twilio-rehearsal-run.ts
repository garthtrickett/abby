import { setTimeout as delay } from "node:timers/promises";
import twilio from "twilio";
import type { TwilioVoiceRehearsal } from "./twilio-voice-rehearsal.ts";

export type RehearsalCarrier = Readonly<{
  eligibleCaller(): Promise<boolean>;
  launch(twiml: string): Promise<string>;
  status(callSid: string): Promise<string>;
  end(callSid: string): Promise<void>;
}>;
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

/** Adapter is test-only and never reads/writes clinic workflow permissions. */
export function rehearsalCarrier(accountSid: string, authToken: string, from: string, to: string): RehearsalCarrier {
  const client = twilio(accountSid, authToken, { autoRetry: false, timeout: 10_000 });
  return {
    async eligibleCaller() {
      const owned = await client.incomingPhoneNumbers.list({ phoneNumber: from, limit: 2 });
      if (owned.some(n => n.phoneNumber === from && n.capabilities.voice)) return true;
      const verified = await client.outgoingCallerIds.list({ phoneNumber: from, limit: 2 });
      return verified.some(n => n.phoneNumber === from);
    },
    async launch(twiml) {
      const call = await client.calls.create({ from, to, twiml, timeout: 20, timeLimit: 180, record: false });
      if (call.accountSid !== accountSid || call.from !== from || call.to !== to ||
          call.direction !== "outbound-api" || !/^CA[0-9a-f]{32}$/.test(call.sid)) throw Error("Unknown launch outcome");
      return call.sid;
    },
    async status(callSid) {
      const call = await client.calls(callSid).fetch();
      if (call.sid !== callSid || call.accountSid !== accountSid || call.from !== from || call.to !== to ||
          call.direction !== "outbound-api") throw Error("Call identity unavailable");
      return call.status;
    },
    async end(callSid) { await client.calls(callSid).update({ status: "completed" }); },
  };
}

export type RehearsalReceipt = Readonly<{
  phase: "launchIntent" | "launchUnknown" | "bound" | "terminal" | "terminalUnknown";
  callSid?: string; summary: ReturnType<TwilioVoiceRehearsal["summary"]>;
}>;

/** Exactly one create attempt. A lost acknowledgement stays unknown: no retry or
 * latest-call lookup. Poll/cleanup address only that exact acknowledged leg. */
export async function runRehearsal(rehearsal: TwilioVoiceRehearsal, carrier: RehearsalCarrier,
  save: (receipt: RehearsalReceipt) => void, options: Readonly<{
    signal: AbortSignal; now?: () => number; wait?: () => Promise<void>;
  }>): Promise<ReturnType<TwilioVoiceRehearsal["summary"]>> {
  if (options.signal.aborted) throw Error("Test canceled before launch");
  const eligible = await carrier.eligibleCaller();
  if (options.signal.aborted) throw Error("Test canceled before launch");
  if (!eligible) throw Error("Test caller is not eligible");
  const now = options.now ?? Date.now, wait = options.wait ?? (() => delay(1_000));
  const deadline = now() + 210_000;
  save({ phase: "launchIntent", summary: rehearsal.summary() });
  let callSid: string;
  if (options.signal.aborted) throw Error("Test canceled before launch");
  try { callSid = await carrier.launch(rehearsal.initialTwiml()); }
  catch {
    save({ phase: "launchUnknown", summary: rehearsal.summary() });
    throw Error("Launch outcome unknown; do not retry without reconciliation");
  }
  let cleanupSent = false;
  try {
    rehearsal.bindCall(callSid);
    save({ phase: "bound", callSid, summary: rehearsal.summary() });
    while (now() < deadline && !options.signal.aborted) {
      const status = await carrier.status(callSid);
      if (options.signal.aborted) break;
      if (terminal.has(status)) {
        rehearsal.observeTerminal(callSid, status);
        save({ phase: "terminal", callSid, summary: rehearsal.summary() });
        return rehearsal.summary();
      }
      if (rehearsal.summary().failed && !cleanupSent) { cleanupSent = true; await carrier.end(callSid); }
      await wait();
    }
  } catch { /* A provider read failure cannot become a terminal pass. */ }
  rehearsal.invalidateRun();
  try {
    if (!cleanupSent) { cleanupSent = true; await carrier.end(callSid); }
    const status = await carrier.status(callSid);
    if (terminal.has(status)) {
      rehearsal.observeTerminal(callSid, status);
      save({ phase: "terminal", callSid, summary: rehearsal.summary() });
      return rehearsal.summary();
    }
  } catch { /* Own exact call only; no blind replacement or shared call scan. */ }
  save({ phase: "terminalUnknown", callSid, summary: rehearsal.summary() });
  return rehearsal.summary();
}
