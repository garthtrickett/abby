import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { twilioStatusDeliveryFixture } from "./twilio-outbound-status-delivery.ts";
import { value } from "./outbound-records.ts";
import { twilioOutboundStatusReceiver } from "../../src/standalone/twilio-outbound-status-receiver.ts";

type Fixture = Awaited<ReturnType<typeof twilioStatusDeliveryFixture>>;
export async function twilioStatusReceiverFixture(options: NonNullable<Parameters<typeof twilioStatusDeliveryFixture>[0]> & {
  httpDeadlineMs?: number; configure?: (fixture: Fixture) => void;
} = {}) {
  const { httpDeadlineMs = 5000, configure, ...rest } = options, f = await twilioStatusDeliveryFixture(rest);
  try {
    configure?.(f); const state = { ingress: true, progress: 0, sessions: 0 };
    const receiver = twilioOutboundStatusReceiver({ runtime: f.recoveryPorts.runtime, delivery: value(f.makeDelivery()), deadlineMs: httpDeadlineMs,
      authority: { allows: async () => state.ingress, current: () => state.ingress },
      sessionEffects: () => { state.sessions++; throw Error("Status cannot acquire a voice session"); },
      createCall: async () => { throw Error("Status cannot start a conversation"); }, observeProgress: async () => { state.progress++; } });
    const server = createServer(async (request, response) => { if (!await receiver.handleHttp(request, response)) { response.writeHead(404); response.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const send = async (request = f.request()) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${request.requestTarget}`, { method: request.method,
        headers: { "content-type": request.contentType!, "x-twilio-signature": request.signature! }, body: request.body });
      assert.equal(await response.text(), ""); return response.status;
    };
    const close = async () => { receiver.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await f.close(); };
    return { ...f, get claims() { return f.claims; }, httpState: state, sendStatus: send, closeReceiver: close };
  } catch (e) { await f.close(); throw e; }
}
