import { createServer, request } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

type Ports = Readonly<{ target: number; caller: number }>;

/** One loopback entry for the two isolated rehearsal listeners. The only
 * public routes are the exact test webhook, media socket and caller callbacks.
 * It does not inspect speech, authorize a call or expose a clinic host. */
export function createTwilioRehearsalGateway(ports: Ports) {
  if (!Number.isSafeInteger(ports.target) || !Number.isSafeInteger(ports.caller) ||
      ports.target < 1024 || ports.caller < 1024 || ports.target > 65535 ||
      ports.caller > 65535 || ports.target === ports.caller)
    throw new RangeError("Invalid rehearsal listener ports");

  const sockets = new Set<Duplex>();
  const route = (method: string | undefined, path: string | undefined): number | undefined => {
    if (method === "POST" && path === "/twilio/inbound") return ports.target;
    if (method === "GET" && path === "/healthz") return ports.caller;
    if (method === "POST" && /^\/voice-rehearsal\/[a-f0-9]{32}\/[0-3]$/.test(path ?? "")) return ports.caller;
    if (method === "POST" && /^\/fallback-ringing\/[a-f0-9]{32}$/.test(path ?? "")) return ports.caller;
    return undefined;
  };
  const server = createServer((incoming, outgoing) => {
    const port = route(incoming.method, incoming.url);
    if (!port) { outgoing.writeHead(404, { "cache-control": "no-store" }); outgoing.end(); return; }
    const upstream = request({ hostname: "127.0.0.1", port, method: incoming.method,
      path: incoming.url, headers: incoming.headers, timeout: 10_000 }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Rehearsal upstream timed out")));
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "cache-control": "no-store" });
      outgoing.end();
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, client, head) => {
    if (incoming.method !== "GET" || incoming.url !== "/twilio/media/") {
      client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = connect(ports.target, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", close); upstream.on("error", close);
    client.on("close", close); upstream.on("close", close);
    upstream.on("connect", () => {
      const headers = incoming.rawHeaders.map((value, index) =>
        index % 2 === 0 ? `${value}: ${incoming.rawHeaders[index + 1]}\r\n` : "").join("");
      upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  let stopping: Promise<void> | undefined;
  return { server, stop(): Promise<void> {
    return stopping ??= (async () => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })();
  } };
}
