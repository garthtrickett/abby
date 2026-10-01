import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { OperationalCounts } from "../../src/voice/operational-counts.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("operational HTTP read refuses malformed aggregate snapshots", async () => {
  const ingress = new TwilioSignedIngress({ accountSid: `AC${"1".repeat(32)}`,
    authToken: "synthetic-token", publicWebhookUrl: "https://calls.example.test/twilio/inbound",
    publicStreamUrl: "wss://calls.example.test/twilio/media/",
    fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x44) });
  const tokenHex = "a".repeat(64);
  let snapshot: unknown = { admissionDenied: 1, callOwnerStarted: 1, voiceFailure: 0, callEnded: 0 };
  const server = createTwilioIngressServer({ ingress,
    operationalRead: { tokenHex, snapshot: () => snapshot as OperationalCounts },
    createCall: async () => { throw new Error("no call expected"); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/operations`;
  const headers = { authorization: `Bearer ${tokenHex}` };
  try {
    const valid = await fetch(url, { headers });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), snapshot);
    snapshot = { admissionDenied: 1, callOwnerStarted: 1, voiceFailure: 0, callEnded: 0,
      callerNumber: "+6145550101" };
    const extra = await fetch(url, { headers });
    assert.equal(extra.status, 503);
    assert.equal((await extra.text()).includes("+6145550101"), false);
    snapshot = { admissionDenied: 1, callOwnerStarted: 1, voiceFailure: -1, callEnded: 0 };
    assert.equal((await fetch(url, { headers })).status, 503);
  } finally {
    server.close();
    await once(server, "close");
  }
});
