import { randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { HostDashboardIdentity } from "./dashboard/server.ts";
import { OperatorAlertWorkflow } from "./operator-alert-workflow.ts";
import { validOperationalAlert } from "./operational-alert.ts";

type Identity = Pick<HostDashboardIdentity, "publicOrigin" | "resolveActor" | "unauthorized">;
const script = `
const list = document.querySelector('#alerts'), status = document.querySelector('#status');
let busy = false;
const labels = {awaitingOwner:'Awaiting owner',awaitingBackup:'Awaiting backup',acknowledged:'Responsibility accepted'};
async function load() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/operator-alerts', {redirect:'error'});
    if (!response.ok) throw Error();
    const rows = await response.json();
    list.replaceChildren();
    if (!rows.length) list.textContent = 'No retained alerts for your approved responsibilities.';
    for (const row of rows) {
      const card = document.createElement('section'), heading = document.createElement('h2'), detail = document.createElement('p');
      heading.textContent = row.alert.kind.replace(/([A-Z])/g, ' $1').replace(/^./, s=>s.toUpperCase());
      detail.textContent = row.alert.date + ' · First accepted count: ' + row.alert.count + ' · Threshold: ' + row.alert.threshold;
      const state = document.createElement('p');
      state.textContent = labels[row.state] + ' · Assigned to ' + row.assignedTo + (row.responsibilityUntil ? ' until ' + row.responsibilityUntil : '');
      card.append(heading,detail,state);
      if (row.canAcknowledge) {
        const button = document.createElement('button'); button.textContent = 'I’m handling this';
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await fetch('/api/operator-alerts/acknowledge', {method:'POST',redirect:'error',headers:{'content-type':'application/json'},
              body:JSON.stringify({alert:row.alert,expectedVersion:row.version})});
            status.textContent = result.ok ? 'Responsibility accepted for the approved period.' : 'Responsibility could not be accepted. Refresh to check the current assignment.';
          } catch { status.textContent = 'The result is unavailable. Refresh to check whether responsibility was accepted.'; }
          await load();
        }; card.append(button);
      }
      list.append(card);
    }
  } catch { list.replaceChildren(); list.textContent = 'Operational alerts are unavailable. Contact your designated support team.'; }
  finally { busy = false; }
}
document.querySelector('#refresh').onclick = load;
load(); setInterval(load,30000);
`;
const style = `body{font:18px/1.5 system-ui,sans-serif;max-width:850px;margin:3rem auto;padding:0 1rem;color:#182a35;background:#f7fafb}
section{border:1px solid #b9cbd3;border-radius:12px;padding:1rem;margin:1rem 0;background:white}button{font:inherit;padding:.6rem 1rem;cursor:pointer}button:disabled{cursor:wait}h2{font-size:1.2rem}`;
function reply(response: ServerResponse, status: number, value: unknown) {
  if (!response.destroyed && !response.writableEnded) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff" }).end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1024) throw new Error("invalid request"); chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Compose with the host's current authenticated identity. Sender bearer keys,
 * request actor fields and arbitrary headers never grant operator authority. */
export function createOperatorAlertHttp(identity: Identity, workflow: OperatorAlertWorkflow): Readonly<{ handle: RequestListener; close(): Promise<void> }> {
  const origin = new URL(identity.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== identity.publicOrigin || origin.username || origin.password ||
      typeof identity.resolveActor !== "function" || !(workflow instanceof OperatorAlertWorkflow)) throw new RangeError("invalid operator alert host");
  const tasks = new Set<Promise<void>>(), requests = new Set<IncomingMessage>(); let closed = false;
  const handle: RequestListener = (request, response) => {
    if (closed || tasks.size >= 32) { reply(response, 503, { error: "unavailable" }); request.resume(); return; }
    const timer = setTimeout(() => { reply(response, 503, { error: "unavailable" }); request.destroy(); }, 5000);
    requests.add(request);
    const task = (async () => {
      try {
        if (request.headers.host !== origin.host || (request.method === "POST" && request.headers.origin !== origin.origin)) {
          reply(response, 403, { error: "forbidden" }); request.resume(); return;
        }
        const actor = await identity.resolveActor(request);
        if (!actor) { request.resume(); if (identity.unauthorized) identity.unauthorized(response, request); else reply(response, 403, { error: "forbidden" }); return; }
        if (response.destroyed || response.writableEnded) return;
        if (request.method === "GET" && (request.url === "/" || request.url === "/operator-alerts")) {
          await workflow.view(actor);
          const nonce = randomBytes(16).toString("base64");
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
          response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operational alerts · Abby</title><style nonce="${nonce}">${style}</style></head><body><main><h1>Operational alerts</h1><p>Counts show the first accepted alert, not current clinic health. Accepting responsibility does not complete a patient request.</p><button id="refresh">Refresh alerts</button><p id="status" role="status"></p><div id="alerts" aria-live="polite">Loading alerts…</div></main><script nonce="${nonce}">${script}</script></body></html>`); return;
        }
        if (request.method === "GET" && request.url === "/api/operator-alerts") { reply(response, 200, await workflow.view(actor)); return; }
        if (request.method === "POST" && request.url === "/api/operator-alerts/acknowledge") {
          if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined) {
            request.resume(); reply(response, 400, { error: "invalidRequest" }); return;
          }
          let value: unknown; try { value = await body(request); } catch { reply(response, 400, { error: "invalidRequest" }); return; }
          if (response.destroyed || response.writableEnded) return;
          const row = value as Record<string, unknown>;
          if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join("|") !== "alert|expectedVersion" ||
              !validOperationalAlert(row.alert) || !Number.isSafeInteger(row.expectedVersion) || Number(row.expectedVersion) < 0) {
            reply(response, 400, { error: "invalidRequest" }); return;
          }
          const result = await workflow.acknowledge(actor, row.alert, Number(row.expectedVersion));
          reply(response, result === "acknowledged" ? 200 : result === "conflict" ? 409 : 403, { result }); return;
        }
        request.resume(); reply(response, 404, { error: "notFound" });
      } catch { reply(response, 503, { error: "unavailable" }); }
      finally { clearTimeout(timer); requests.delete(request); }
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {});
  };
  return { handle, async close() { closed = true; for (const request of requests) request.destroy(); await Promise.allSettled([...tasks]); } };
}
