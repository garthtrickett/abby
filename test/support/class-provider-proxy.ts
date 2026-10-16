import { createServer } from "node:http";
import { once } from "node:events";

/** Independent fake-provider lifetime after caller disposal. GET only, loopback
 * only, with the fixture's fixed synthetic credential. Never a production port. */
export async function classProviderProxy(fetchPort: typeof fetch, apiKey: string) {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
      process.env.ABBY_SYNTHETIC_CLASS_COLD_RECOVERY !== "1" || apiKey !== "synthetic-key-au5")
    throw new Error("isolated signed cold recovery fixture required");
  const traffic: string[] = [], methods: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method ?? "");
      if (req.method !== "GET" || req.headers.authorization !== "Basic " + Buffer.from(apiKey + ":").toString("base64") ||
          !req.url?.startsWith("/v1/") || req.url.length > 4096) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, "https://api.au5.cliniko.com");
      if (url.origin !== "https://api.au5.cliniko.com" || !url.pathname.startsWith("/v1/")) { res.writeHead(403); res.end(); return; }
      traffic.push(url.pathname);
      const response = await fetchPort(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: req.headers.authorization, "User-Agent": String(req.headers["user-agent"] ?? "") } });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 262144) throw new Error("synthetic provider response exceeds bound");
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(body);
    } catch { res.writeHead(502); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("synthetic provider unavailable");
  return { origin: "http://127.0.0.1:" + address.port,
    audit: () => ({ reads: traffic.length, nonGet: methods.filter(method => method !== "GET").length,
      protectedReads: traffic.filter(path => /^\/v1\/(?:group_appointments|attendees|patient_cases|patients)(?:\/|$)/.test(path)).length }),
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
