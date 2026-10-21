import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ClinikoTwilioOutboundNotificationDelivery } from "../../src/standalone/cliniko-twilio-outbound-notification-delivery.ts";
import { TwilioOutboundIngress } from "../../src/voice/twilio-outbound-ingress.ts";
import { twilioNotificationRecoveryFixture } from "./twilio-outbound-notification-recovery.ts";
import { value } from "./outbound-records.ts";

export async function twilioNotificationDeliveryFixture(options: NonNullable<Parameters<typeof twilioNotificationRecoveryFixture>[0]> = {}) {
  const f = await twilioNotificationRecoveryFixture({ ...options, initialObservation: false });
  const state = { ingress: true, progress: 0 };
  const native: typeof fetch = (input, init) => init?.method === "POST" ? f.native.port(input, init) : f.recoveryPorts.native(input, init);
  const config = { runtime: f.runtime, observations: f.observations, attempts: f.recoveryConfig.call.attempts, key: f.key, maximumNativeRequests: 180 };
  const ports = { ...f.ports, native, history: f.recoveryPorts.history };
  const make = () => value(ClinikoTwilioOutboundNotificationDelivery.create(config, ports)), delivery = make();
  const receiver = new TwilioOutboundIngress({ runtime: f.runtime, deadlineMs: 2000,
    receiveAuthenticatedStatus: async (request, _event, signal) => {
      const result = await delivery.receiveStatus(request, signal); if (!result.ok) throw Error("Unresolved notification retention");
    },
    authority: { allows: async () => state.ingress, current: () => state.ingress },
    sessionEffects: () => { throw Error("Status must not acquire a session"); }, createCall: async () => { throw Error("Status must not create a conversation"); },
    observeProgress: async () => { state.progress++; } });
  const server = createServer(async (request, response) => { if (!await receiver.handleHttp(request, response)) { response.writeHead(404); response.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = async (request = f.request()) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${request.requestTarget}`, { method: request.method, headers: { "content-type": request.contentType!, "x-twilio-signature": request.signature! }, body: request.body });
    assert.equal(await response.text(), ""); return response.status;
  };
  const close = async () => { receiver.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); };
  return { ...f, delivery, deliveryConfig: config, deliveryPorts: ports, deliveryState: state, makeDelivery: make, sendStatus: send, closeDelivery: close };
}
