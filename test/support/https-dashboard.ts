import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import type { HostDashboardIdentity } from "../../src/standalone/dashboard/server.ts";
import { listenLoopbackServer } from "./listen-loopback-server.ts";

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

/** Real local TLS into the authenticated dashboard, with a fresh synthetic certificate per case. */
export async function withHttpsDashboard(identity: Omit<HostDashboardIdentity, "publicOrigin">,
                                         run: (origin: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "abby-dashboard-tls-"));
  let proxy: Server | undefined;
  let backend: Server | undefined;
  let backendPort: number | undefined;
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
    { timeout: 10_000 });
    const [keyBytes, certBytes] = await Promise.all([readFile(key), readFile(cert)]);
    proxy = createServer({ key: keyBytes, cert: certBytes }, (incoming, response) => {
      if (backendPort === undefined) { response.writeHead(503).end(); return; }
      const forwarded = request({ hostname: "127.0.0.1", port: backendPort, method: incoming.method,
        path: incoming.url, headers: incoming.headers }, upstream => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      });
      forwarded.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.on("close", () => forwarded.destroy());
      incoming.pipe(forwarded);
    });
    const bound = await listenLoopbackServer(proxy);
    const origin = bound.replace("http:", "https:");
    backend = await createHostAuthenticatedDashboardServer({ ...identity, publicOrigin: origin },
      resolve("dist/dashboard/app.js"));
    backendPort = Number(new URL(await listenLoopbackServer(backend)).port);
    await run(origin);
  } finally {
    try { await Promise.all([close(proxy), close(backend)]); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
