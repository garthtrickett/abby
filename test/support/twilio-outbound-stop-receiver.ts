import assert from "node:assert/strict";
import { once } from "node:events";
import { twilioOutboundStopRecoveryFixture } from "./twilio-outbound-stop-recovery.ts";
import { value } from "./outbound-records.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { twilioOutboundStopReceiver } from "../../src/standalone/twilio-outbound-stop-receiver.ts";
import type { TwilioOutboundIngressConfig } from "../../src/voice/twilio-outbound-ingress.ts";

export async function twilioOutboundStopReceiverFixture(options: Parameters<typeof twilioOutboundStopRecoveryFixture>[0] & {
  receiverRuntime?: { twilioOutboundStopReceiver: typeof twilioOutboundStopReceiver; TwilioSignedIngress: typeof TwilioSignedIngress;
    createTwilioIngressServer: typeof createTwilioIngressServer };
  deadlineMs?: number;
} = {}) {
  const { receiverRuntime = { twilioOutboundStopReceiver, TwilioSignedIngress, createTwilioIngressServer }, deadlineMs, ...recoveryOptions } = options;
  const f = await twilioOutboundStopRecoveryFixture(recoveryOptions);
  const state = { allowed: true, current: true, progress: [] as string[], argumentCounts: [] as number[] };
  const routers = new Set<ReturnType<typeof twilioOutboundStopReceiver>>(), servers = new Set<import("node:http").Server>();
  const config: TwilioOutboundIngressConfig = { runtime: f.recoveryPorts.runtime,
    authority: { allows: async () => state.allowed, current: () => state.current },
    sessionEffects: () => { throw Error("Status recovery cannot consume a conversation session"); },
    createCall: async () => { throw Error("Status recovery cannot construct a conversation"); },
    observeProgress: async function (event, signal) {
      state.progress.push(event.status); state.argumentCounts.push(arguments.length);
      assert.equal(signal instanceof AbortSignal, true); assert.deepEqual(Object.keys(event).sort(), ["call", "status"]);
    },
    ...(deadlineMs ? { deadlineMs } : {}) };
  const close = async () => { for (const router of routers) router.close(); for (const server of servers) if (server.listening) {
    const done = once(server, "close"); server.close(); await done; } await f.close(); };
  async function listen(selected = value(f.makeRecovery())) {
    const router = receiverRuntime.twilioOutboundStopReceiver({ ...config, stopRecovery: selected }); routers.add(router);
    const ingress = new receiverRuntime.TwilioSignedIngress({ accountSid: f.carrier.accountSid, authToken: f.carrier.authToken,
      publicWebhookUrl: "https://clinic.example.invalid/inbound", publicStreamUrl: "wss://clinic.example.invalid/inbound/stream",
      fallbackNumbers: { [f.carrier.from]: "+61255550199" }, bindingKey: Buffer.alloc(32, 9), now: () => new Date(f.state.now) });
    const server = receiverRuntime.createTwilioIngressServer({ ingress, outbound: router,
      createCall: async () => { throw Error("Outbound stop must not enter incoming call construction"); } });
    servers.add(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    return { post: (patch: Record<string, string> = {}, valid = true) => {
      const raw = f.request(patch);
      return fetch(base + raw.requestTarget, { method: "POST", headers: { "content-type": raw.contentType,
        "x-twilio-signature": valid ? raw.signature : "foreign" }, body: raw.body });
    } };
  }
  return { ...f, receiverState: state, receiverConfig: config, listen, closeReceiver: close };
}
