import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import twilio from "twilio";
import WebSocket from "ws";
import { createTwilioIngressServer } from "../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../src/voice/twilio-signed-ingress.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
probe.close();
await once(probe, "close");

const tunnel = spawn("ngrok", ["http", String(port), "--log=stdout", "--log-format=json"],
  { stdio: ["ignore", "pipe", "ignore"] });
let server;
try {
  const publicBase = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tunnel startup timed out")), 15_000);
    const lines = createInterface({ input: tunnel.stdout });
    lines.on("line", line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.msg === "started tunnel" && typeof record.url === "string" &&
          record.url.startsWith("https://")) {
        clearTimeout(timer);
        resolve(record.url);
      }
    });
    tunnel.once("exit", code => { clearTimeout(timer); reject(new Error(`tunnel exited ${code}`)); });
    tunnel.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const host = new URL(publicBase).host;
  const webhookUrl = `https://${host}/twilio/inbound`;
  const streamUrl = `wss://${host}/twilio/media/`;
  const ingress = new TwilioSignedIngress({ accountSid: `AC${"1".repeat(32)}`,
    authToken: "synthetic-token", publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
    fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x66) });
  let startedCalls = 0;
  server = createTwilioIngressServer({ ingress, admitWebhook: async event => event !== undefined,
    createCall: async () => { startedCalls += 1; return {
      receive: async () => ({ ok: true }), disconnect: async () => {},
    }; } });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let transportPassed = false;
  for (let attempt = 0; attempt < 3 && !transportPassed; attempt += 1) {
    const check = spawn(process.execPath, ["scripts/preflight-voice-public.ts", "--transport-only"],
      { cwd: root, env: { ...process.env, ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl,
        ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl }, stdio: ["ignore", "ignore", "ignore"] });
    const [exitCode] = await once(check, "exit");
    transportPassed = exitCode === 0;
    if (!transportPassed) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!transportPassed) throw new Error("public tunnel transport preflight failed");
  process.stdout.write("public HTTPS/WSS routes reachable and reject unsigned traffic\n");
  const accountSid = `AC${"1".repeat(32)}`;
  const callSid = `CA${"2".repeat(32)}`;
  const streamSid = `MZ${"3".repeat(32)}`;
  const form = { AccountSid: accountSid, CallSid: callSid, To: "+6125550199", From: "+6145550101" };
  const signed = await fetch(webhookUrl, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": twilio.getExpectedTwilioSignature("synthetic-token", webhookUrl, form),
  }, body: new URLSearchParams(form), signal: AbortSignal.timeout(5_000) });
  if (signed.status !== 200) throw new Error(`signed public webhook rejected ${signed.status}`);
  const binding = (await signed.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
  if (!binding) throw new Error("signed public webhook omitted stream binding");
  const socket = new WebSocket(streamUrl, { handshakeTimeout: 5_000, headers: {
    "x-twilio-signature": twilio.getExpectedTwilioSignature("synthetic-token", streamUrl, {}),
  } });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    const deadline = Date.now() + 5_000;
    while (startedCalls !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (startedCalls !== 1) throw new Error("signed public stream never created a call owner");
    process.stdout.write("signed HTTPS/WSS binding created one call owner through the tunnel\n");
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    } else socket.terminate();
  }
} finally {
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  if (tunnel.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
    const stopped = once(tunnel, "exit");
    tunnel.kill("SIGTERM");
    await stopped;
  }
}
