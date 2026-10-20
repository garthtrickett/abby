import type { IncomingMessage, ServerResponse } from "node:http";
import { ClinikoStripeWebhookHandoff } from "./cliniko-stripe-webhook-handoff.ts";
import type { OwnedBodyStream } from "../shared/owned-body-bytes.ts";

function body(request: IncomingMessage): OwnedBodyStream {
  // A Web adapter's cancel destroys IncomingMessage immediately. Retire our
  // reader without destroying the response socket before its fixed refusal is
  // sent. Unread bytes are paused and the route closes the connection on reply.
  const iterator = request.iterator({ destroyOnReturn: false });
  return { getReader: () => ({ async read() {
    const next = await iterator.next(); return { done: next.done === true, value: next.value };
  }, async cancel() {
    request.pause(); await iterator.return?.();
  }, releaseLock() {} }) };
}

/** Raw-byte route for an explicitly provisioned handoff. This does not start a
 * listener, configure public ingress or activate the financial consumer. */
export function stripeFinancialWebhookHandler(handoff: ClinikoStripeWebhookHandoff) {
  if (!(handoff instanceof ClinikoStripeWebhookHandoff)) throw new TypeError("Invalid financial handoff");
  const lifetime = new AbortController(), tasks = new Set<Promise<void>>();
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const reply = (status: number) => {
      if (response.destroyed || response.writableEnded) return;
      // No upstream detail, references, patient data or provider payload escapes.
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "connection": "close" });
      if (!request.complete) response.once("finish", () => request.destroy());
      response.end(status === 200 ? '{"ok":true}' : '{"ok":false}');
    };
    if (request.url !== "/stripe/webhook") { reply(404); return; }
    if (request.method !== "POST") { reply(405); return; }
    const signatureHeaders = request.rawHeaders.filter((_value, i, headers) => i % 2 === 0 && headers[i]!.toLowerCase() === "stripe-signature");
    const signature = request.headers["stripe-signature"];
    const length = request.headers["content-length"];
    if (request.headers["content-encoding"] !== undefined ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(request.headers["content-type"] ?? "")) ||
        signatureHeaders.length !== 1 || typeof signature !== "string" ||
        length !== undefined && (!/^[0-9]{1,9}$/.test(length) || Number(length) < 1 || Number(length) > 262_144)) { reply(400); return; }
    if (lifetime.signal.aborted || tasks.size >= 32) { reply(503); return; }
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    const closed = () => { if (!response.writableFinished) abort(); };
    request.once("aborted", abort); response.once("close", closed);
    const task = (async () => {
      try {
        const result = await handoff.accept(body(request), signature, AbortSignal.any([disconnected.signal, lifetime.signal]));
        const invalid = !result.ok && ["invalidWebhook", "foreignEndpoint", "unsupportedVersion"].includes(result.error.kind);
        reply(result.ok ? 200 : invalid ? 400 : 503);
      } catch { reply(503); }
      finally { request.off("aborted", abort); response.off("close", closed); }
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {});
  };
  return Object.freeze({ handle, async close() { lifetime.abort(); await Promise.allSettled([...tasks]); } });
}
