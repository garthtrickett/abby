import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { operationalDays } from "../../src/voice/operational-counts.ts";
import type { OperationalCounts, OperationalDailyCounts } from "../../src/voice/operational-counts.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("operational HTTP read refuses malformed aggregate snapshots", async () => {
  const ingress = new TwilioSignedIngress({ accountSid: `AC${"1".repeat(32)}`,
    authToken: "synthetic-token", publicWebhookUrl: "https://calls.example.test/twilio/inbound",
    publicStreamUrl: "wss://calls.example.test/twilio/media/",
    fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x44) });
  const tokenHex = "a".repeat(64);
  const counts = { admissionDenied: 1, callOwnerStarted: 1, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0, intentClassificationUnavailable: 0 };
  let snapshot: unknown = counts;
  let dailySnapshot: unknown = { days: operationalDays("2026-10-01T12:00:00.000Z")
    .map(date => ({ date, counts })) };
  const server = createTwilioIngressServer({ ingress,
    operationalRead: { tokenHex, snapshot: () => snapshot as OperationalCounts,
      daily: () => dailySnapshot as OperationalDailyCounts },
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
    snapshot = { ...counts, callerNumber: "+6145550101" };
    const extra = await fetch(url, { headers });
    assert.equal(extra.status, 503);
    assert.equal((await extra.text()).includes("+6145550101"), false);
    snapshot = { ...counts, voiceFailure: -1 };
    assert.equal((await fetch(url, { headers })).status, 503);
    const dailyUrl = `${url}/daily`;
    assert.equal((await fetch(dailyUrl)).status, 403);
    assert.equal((await fetch(dailyUrl, { method: "POST", headers })).status, 403);
    const daily = await fetch(dailyUrl, { headers });
    assert.equal(daily.status, 200);
    assert.equal(daily.headers.get("cache-control"), "no-store");
    assert.deepEqual(await daily.json(), dailySnapshot);
    dailySnapshot = { days: operationalDays("2026-10-01T12:00:00.000Z")
      .map(date => ({ date, counts: { ...counts, callerNumber: "+6145550101" } })) };
    const extraDaily = await fetch(dailyUrl, { headers });
    assert.equal(extraDaily.status, 503);
    assert.equal((await extraDaily.text()).includes("+6145550101"), false);
    dailySnapshot = { days: ["2026-09-30", "2026-10-01"].map(date => ({ date, counts })) };
    assert.equal((await fetch(dailyUrl, { headers })).status, 503);
  } finally {
    server.close();
    await once(server, "close");
  }
});
