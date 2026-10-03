import { html, render } from "lit-html";

const root = document.querySelector<HTMLElement>("#sign-in");
if (!root) throw new Error("Sign-in unavailable");
const target = root, mode = root.dataset.mode, csrf = root.dataset.csrf ?? "";
// Keep the bearer secret only in memory; remove it before any HTTP request or user interaction.
const secret = window.location.hash.slice(1);
window.history.replaceState(null, "", window.location.pathname);
// A second emailed link can navigate this existing page without loading a new document.
// Load a fresh confirmation; initialization removes its fragment before inspecting it.
window.addEventListener("hashchange", () => { if (window.location.hash) window.location.reload(); });
let email = "", busy = false, notice = "", problem = "", confirmedEmail: string | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
async function post(path: string, value: unknown): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const result = record(await response.json());
    return response.ok && result?.ok === true ? result : undefined;
  } catch { return undefined; }
}
async function requestLink(event: Event): Promise<void> {
  event.preventDefault(); if (busy) return;
  busy = true; notice = ""; problem = ""; draw();
  const result = await post("/sign-in/request", { email, csrf });
  if (result && Object.keys(result).sort().join(",") === "message,ok" &&
      result.message === "If this account can sign in, check your email for a link.") notice = result.message;
  else problem = "The request could not be confirmed. Check your email before trying again.";
  busy = false; draw();
}
async function redeem(): Promise<void> {
  if (busy || !confirmedEmail) return;
  busy = true; problem = ""; draw();
  const result = await post("/sign-in/redeem", { csrf, secret });
  if (result && Object.keys(result).join(",") === "ok") { window.location.assign("/"); return; }
  confirmedEmail = undefined; problem = "This link could not sign you in. Request a new link."; busy = false; draw();
}
async function logout(): Promise<void> {
  if (busy) return;
  busy = true; problem = ""; draw();
  const result = await post("/sign-in/logout", {});
  if (result && Object.keys(result).join(",") === "ok") { window.location.assign("/sign-in"); return; }
  problem = "Sign-out could not be confirmed. Please try again."; busy = false; draw();
}
function draw(): void {
  render(html`<h1>${mode === "logout" ? "Sign out of Abby" : "Sign in to Abby"}</h1>
    ${mode === "confirm" ? html`
      ${confirmedEmail ? html`<p>Sign in as <strong>${confirmedEmail}</strong>?</p>
        <button type="button" ?disabled=${busy} @click=${() => { void redeem(); }}>Continue to Abby</button>`
        : busy ? html`<p>Checking your link…</p>` : ""}
      <p><a href="/sign-in">Request a new link</a></p>`
      : mode === "logout" ? html`<p>This signs out your current browser session.</p>
        <button type="button" ?disabled=${busy} @click=${() => { void logout(); }}>Sign out</button>
        <p><a href="/">Back to Abby</a></p>`
        : html`<p>Use your approved clinic account.</p><form @submit=${(event: Event) => { void requestLink(event); }}>
          <label>Email <input type="email" name="email" autocomplete="email" required maxlength="254"
            ?disabled=${busy} .value=${email} @input=${(event: Event) => { email = (event.target as HTMLInputElement).value; }}></label>
          <button type="submit" ?disabled=${busy}>Email me a sign-in link</button></form>`}
    ${notice ? html`<p role="status">${notice}</p>` : ""}${problem ? html`<p role="alert">${problem}</p>` : ""}`, target);
}
async function start(): Promise<void> {
  if (mode !== "confirm") { draw(); return; }
  busy = true; draw();
  const result = /^[A-Za-z0-9_-]{43}$/.test(secret) ? await post("/sign-in/inspect", { csrf, secret }) : undefined;
  if (result && Object.keys(result).sort().join(",") === "email,ok" && typeof result.email === "string" && result.email.length <= 254) confirmedEmail = result.email;
  else problem = "This link is unavailable or expired. Request a new link.";
  busy = false; draw();
}
void start();
