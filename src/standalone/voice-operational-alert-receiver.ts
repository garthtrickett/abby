import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { VoiceOperationalAlertInbox } from "./voice-operational-alert-inbox.ts";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length; if (size > 1_024) throw new Error("invalid alert request"); chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Loopback listener behind owner-managed HTTPS; never binds a public address.
 * 202 means durable inbox acceptance, not paging or human acknowledgment. */
export async function startVoiceOperationalAlertReceiver(inbox: VoiceOperationalAlertInbox, port = 0) {
  if (!(inbox instanceof VoiceOperationalAlertInbox) || !Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("invalid operational alert receiver");
  await inbox.snapshot();
  const tasks = new Set<Promise<void>>(), controllers = new Set<AbortController>();
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 5_000, maxHeaderSize: 4_096 }, (request, response) => {
    const reply = (status: number) => { if (!response.destroyed) response.writeHead(status, { "cache-control": "no-store" }).end(); };
    if (request.method !== "POST" || request.url !== "/voice-operational-alerts" ||
        request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined) {
      reply(400); request.resume(); return;
    }
    if (tasks.size >= 32) { reply(503); request.resume(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => { controller.abort(); reply(503); request.destroy(); }, 5_000);
    request.on("aborted", () => controller.abort());
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    const task = (async () => {
      try {
        const result = await inbox.accept(await body(request), request.headers.authorization, request.headers["idempotency-key"], controller.signal);
        reply(result === "accepted" ? 202 : result === "invalid" ? 400 : 503);
      } catch { reply(400); }
      finally { clearTimeout(timer); controllers.delete(controller); }
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {});
  });
  server.maxConnections = 64;
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("operational alert receiver unavailable");
  return { port: address.port, async close() {
    for (const controller of controllers) controller.abort();
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await Promise.allSettled([...tasks]); await closed;
  } };
}
