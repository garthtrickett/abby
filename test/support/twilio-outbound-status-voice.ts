import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { twilioOutboundStopSpeechFixture } from "./twilio-outbound-stop-speech.ts";
import { value } from "./outbound-records.ts";
import type { OutboundRecordConfig } from "../../src/cliniko/outbound-recipient-records.ts";
import type { TwilioOutboundTerminalObservationQuery } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import type { TwilioTerminalHistoryAuthority } from "../../src/cliniko/twilio-outbound-terminal-history.ts";
import { TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
import { TwilioOutboundTerminalObservationAuthentication, decodeTwilioOutboundTerminalObservation } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { twilioTerminalObservationProfileBinding } from "../../src/standalone/twilio-outbound-terminal-observation.ts";
import { TwilioOutboundStatusDelivery } from "../../src/standalone/twilio-outbound-status-delivery.ts";
import { twilioOutboundStatusReceiver } from "../../src/standalone/twilio-outbound-status-receiver.ts";

type Options = Omit<NonNullable<Parameters<typeof twilioOutboundStopSpeechFixture>[0]>, "terminalObservationBinding"> & {
  notificationResponse?: "lostStored" | "lostUnstored";
};
/** Actual original carrier POST, signed HTTP/WSS and ASR/native report producer.
 * Callback modules use their real native/SQL owners; remote native/carrier and
 * acoustic providers remain synthetic. No prepared stop report is inserted. */
export async function twilioOutboundStatusVoiceFixture(options: Options = {}) {
  const { notificationResponse, ...rest } = options, notificationKey = randomBytes(32);
  const observationsFor = (r: OutboundRecordConfig) => ({ ...r, outboundTerminalObservationRecallTypeId: "66", terminalObservationPolicyDigest: "a".repeat(64) });
  const f = await twilioOutboundStopSpeechFixture({ ...rest, terminalObservationBinding: r => twilioTerminalObservationProfileBinding(observationsFor(r), notificationKey)! });
  try {
    const state = { source: true, record: true, producer: true, history: true, decoded: true, current: true, ingress: true };
    const posts: Record<string, unknown>[] = []; let next = 900;
    const native: typeof fetch = async (input, init) => {
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (body?.recall_type_id !== "66") return f.nativeSpeech(input, init);
      assert.equal(String(input), "https://api.au5.cliniko.com/v1/recalls"); assert.equal(init!.redirect, "error");
      assert.equal(new Headers(init!.headers).get("Authorization"), `Basic ${Buffer.from(`${f.config.stop.requests.apiKey}:`).toString("base64")}`);
      assert.equal(body.patient_id, f.request.patientId); assert.equal(body.recalled, false); value(decodeTwilioOutboundTerminalObservation(body.notes));
      posts.push(body); const id = String(next++), row = { ...f.retained().row, id, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: f.state.now, updated_at: f.state.now,
        links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/66" } } };
      if (notificationResponse !== "lostUnstored") f.contactControls.rows.push(row);
      if (notificationResponse) throw Error("Synthetic notification acknowledgement lost");
      return Response.json(row, { status: 201 });
    };
    const selected = f.runtime.binding(), auth = new TwilioOutboundTerminalObservationAuthentication(notificationKey, { ref: selected.ref, bindingDigest: selected.bindingDigest });
    const history: TwilioTerminalHistoryAuthority = { allowsHistoryRead: async () => state.history,
      allowsObservationRead: async () => state.decoded, allowsAttemptRead: async (q, s) => state.history && await f.ports.attempt.allows(q, s),
      current: (q, s) => state.current && (q.operation === "readPossibleLaunch" || q.operation === "retainPossibleLaunch" ? f.ports.attempt.current(q, s) : true) };
    const { report: _report, effects: _effects, ...reads } = f.ports;
    const config = { notifications: { config: { runtime: f.runtime, observations: observationsFor(f.config.stop.requests), attempts: f.config.stop.attempts,
      key: notificationKey, maximumNativeRequests: 180 }, ports: {
        source: { read: async () => ({ ok: true as const, value: f.approval }), current: () => state.source && f.stateSpeech.conversation },
        record: { allows: async (q: TwilioOutboundTerminalObservationQuery) => state.record && q.authenticationBinding === auth.authenticationBinding(),
          current: () => state.current, producerAdmitted: async () => state.producer }, effects: f.effects, history, native } },
      stop: { config: f.config, ports: { ...reads, native, runtime: f.runtime, authentication: new TwilioOutboundReportAuthentication(f.key, f.attempt.provider),
        effects: f.effects(f.request.scope, outboundDncRecordBinding(f.config.stop.dnc)!) } }, maximumNativeRequests: 180, deadlineMs: 5000 };
    const make = () => TwilioOutboundStatusDelivery.create(config);
    const request = (patch: Record<string, string> = {}) => {
      const url = new URL(f.form.get("StatusCallback")!), fields = { AccountSid: f.carrier.accountSid, CallSid: f.callSid, From: f.carrier.from,
        To: f.request.recipient.number, Direction: "outbound-api", CallStatus: "completed", ...patch };
      return { method: "POST", requestTarget: url.pathname + url.search, contentType: "application/x-www-form-urlencoded",
        signature: getExpectedTwilioSignature(f.carrier.authToken, url.href, fields), body: new URLSearchParams(fields).toString() };
    };
    const listenStatus = async () => {
      const receiver = twilioOutboundStatusReceiver({ runtime: f.runtime, delivery: value(make()), deadlineMs: 5000,
        authority: { allows: async () => state.ingress, current: () => state.ingress },
        sessionEffects: () => { throw Error("Status cannot acquire a session"); }, createCall: async () => { throw Error("Status cannot create a conversation"); } });
      const server = createServer(async (req, res) => { if (!await receiver.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
      server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
      return { send: async (raw = request()) => { const response = await fetch(`http://127.0.0.1:${address.port}${raw.requestTarget}`, { method: raw.method,
        headers: { "content-type": raw.contentType, "x-twilio-signature": raw.signature }, body: raw.body }); assert.equal(await response.text(), ""); return response.status; },
        close: async () => { receiver.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
    };
    return { ...f, get admitted() { return f.admitted; }, get carrierCalls() { return f.carrierCalls; }, notificationKey, notificationState: state, notificationPosts: posts, statusConfig: config, statusRequest: request, makeStatus: make, listenStatus };
  } catch (e) { await f.close(); throw e; }
}
