import { fileURLToPath } from "node:url";
import twilio from "twilio";
import WebSocket from "ws";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function publicUrl(name: string, protocol: "https:" | "wss:"): URL {
  const url = new URL(required(name));
  if (url.protocol !== protocol || url.username || url.password || url.hash || url.search ||
      url.port || !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error(`invalid ${name}`);
  }
  return url;
}

export function voiceTransportConfig(): Readonly<{ webhookUrl: URL; streamUrl: URL }> {
  const webhookUrl = publicUrl("ABBY_TWILIO_PUBLIC_WEBHOOK_URL", "https:");
  const streamUrl = publicUrl("ABBY_TWILIO_PUBLIC_STREAM_URL", "wss:");
  if (webhookUrl.pathname !== "/twilio/inbound" || streamUrl.pathname !== "/twilio/media/" ||
      webhookUrl.hostname !== streamUrl.hostname) throw new Error("invalid voice transport configuration");
  return { webhookUrl, streamUrl };
}

export function voiceNumberPlanConfig(): Readonly<{
  webhookUrl: URL; streamUrl: URL; fallbackUrl: URL;
  testNumber: string; fallbackNumber: string;
}> {
  if (required("ABBY_VOICE_TEST_MODE") !== "1") throw new Error("invalid ABBY_VOICE_TEST_MODE");
  const { webhookUrl, streamUrl } = voiceTransportConfig();
  const fallbackUrl = publicUrl("ABBY_TWILIO_PUBLIC_FALLBACK_URL", "https:");
  const testNumber = required("ABBY_TWILIO_TEST_NUMBER");
  const callerNumber = required("ABBY_TWILIO_TEST_CALLER_NUMBER");
  const fallbackNumber = required("ABBY_TWILIO_FALLBACK_NUMBER");
  if (webhookUrl.hostname === fallbackUrl.hostname ||
      !/^\+[1-9]\d{1,14}$/.test(testNumber) || !/^\+[1-9]\d{1,14}$/.test(fallbackNumber) ||
      !/^\+[1-9]\d{1,14}$/.test(callerNumber) ||
      new Set([testNumber, callerNumber, fallbackNumber]).size !== 3) {
    throw new Error("invalid voice public configuration");
  }
  return { webhookUrl, streamUrl, fallbackUrl, testNumber, fallbackNumber };
}

export function voicePublicConfig(): ReturnType<typeof voiceNumberPlanConfig> & Readonly<{
  accountSid: string; authToken: string;
}> {
  const plan = voiceNumberPlanConfig();
  const accountSid = required("ABBY_TWILIO_ACCOUNT_SID");
  const authToken = required("ABBY_TWILIO_AUTH_TOKEN");
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error("invalid ABBY_TWILIO_ACCOUNT_SID");
  return { ...plan, accountSid, authToken };
}

function unsignedStreamRejected(url: URL): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve(valid);
    };
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode === 403);
    });
    socket.on("open", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

async function check(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length > 3 ||
      (mode !== undefined && mode !== "--config-only" && mode !== "--transport-only" &&
       mode !== "--dry-run")) {
    throw new Error("invalid preflight argument");
  }
  if (mode === "--dry-run") {
    const plan = voiceNumberPlanConfig();
    process.stdout.write(`${JSON.stringify({
      testNumber: plan.testNumber,
      primary: { url: plan.webhookUrl.href, method: "POST" },
      streamUrl: plan.streamUrl.href,
      fallback: { url: plan.fallbackUrl.href, method: "POST" },
      fallbackDestinationLast4: plan.fallbackNumber.length > 5 ? plan.fallbackNumber.slice(-4) : null,
      voiceApplicationSid: null,
      trunkSid: null,
      applied: false,
    }, null, 2)}\n`);
    return;
  }
  const full = mode === "--transport-only" ? undefined : voicePublicConfig();
  const config = full ?? voiceTransportConfig();
  if (mode === "--config-only") {
    process.stdout.write("voice public configuration valid\n");
    return;
  }
  let primary: Response;
  try {
    primary = await fetch(config.webhookUrl, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ AccountSid: `AC${"0".repeat(32)}` }),
      signal: AbortSignal.timeout(5_000) });
  } catch { throw new Error("public webhook unreachable"); }
  if (primary.status !== 403) throw new Error(`public webhook returned HTTP ${primary.status} for unsigned traffic`);
  if (!await unsignedStreamRejected(config.streamUrl)) {
    throw new Error("public WSS route did not reject unsigned traffic");
  }
  if (!full) {
    process.stdout.write("public HTTPS/WSS routes reachable and reject unsigned traffic\n");
    return;
  }
  const fallback = await fetch(full.fallbackUrl, { signal: AbortSignal.timeout(5_000) });
  const fallbackBody = await fallback.text();
  if (!fallback.ok || fallbackBody.length > 16_384 ||
      !fallbackBody.includes(`<Dial>${full.fallbackNumber}</Dial>`)) {
    throw new Error("independent fallback TwiML unavailable");
  }
  const numbers = await twilio(full.accountSid, full.authToken).incomingPhoneNumbers.list({
    phoneNumber: full.testNumber, limit: 2,
  });
  if (numbers.length !== 1 || numbers[0]?.voiceUrl !== full.webhookUrl.href ||
      numbers[0].voiceMethod !== "POST" || numbers[0].voiceFallbackUrl !== full.fallbackUrl.href ||
      numbers[0].voiceFallbackMethod !== "POST" || numbers[0].voiceApplicationSid || numbers[0].trunkSid) {
    throw new Error("Twilio number voice and fallback routes do not match");
  }
  process.stdout.write("public HTTPS/WSS and Twilio number configuration valid; real call proof still required\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await check(); }
  catch (error) {
    const message = error instanceof Error &&
      (/^(missing|invalid) ABBY_[A-Z0-9_]+$/.test(error.message) ||
       (process.argv[2] === "--transport-only" &&
        /^public (webhook (unreachable|returned HTTP [0-9]{3} for unsigned traffic)|WSS route did not reject unsigned traffic)$/.test(error.message)))
      ? error.message : "voice public preflight failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
