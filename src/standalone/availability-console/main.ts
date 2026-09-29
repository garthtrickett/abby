import { html, render } from "lit-html";

type AvailabilityResponse =
  | { ok: true; value: { status: "shown" | "empty" | "failed"; message: string } }
  | { ok: false; error: { kind: "invalidInput" | "unavailable" } };

const root = document.getElementById("app");
if (!root) throw new Error("availability root missing");

let busy = false;
let result: AvailabilityResponse | undefined;
const today = new Date().toISOString().slice(0, 10);

function view(): void {
  render(html`
    <h1>Abby availability</h1>
    <p>Check possible Cliniko appointment times. Times are provisional; this page cannot reserve or confirm an appointment.</p>
    <form @submit=${submit}>
      <label for="question">Question</label>
      <textarea id="question" name="text" maxlength="4000" required></textarea>
      <div class="dates">
        <label for="from">From <input id="from" name="from" type="date" value=${today} required></label>
        <label for="to">To <input id="to" name="to" type="date" value=${today} required></label>
      </div>
      <button type="submit" ?disabled=${busy}>${busy ? "Checking…" : "Check availability"}</button>
    </form>
    ${result ? html`<section role="status" aria-live="polite"><strong>${result.ok ? result.value.status : "Unavailable"}</strong><p>${result.ok ? result.value.message :
      result.error.kind === "invalidInput" ? "Enter a question and a date range of at most seven days." : "Availability could not be checked. Try again later."}</p></section>` : ""}
  `, root!);
}

async function submit(event: Event): Promise<void> {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget as HTMLFormElement;
  const fields = new FormData(form);
  const request = { text: String(fields.get("text") ?? ""), from: String(fields.get("from") ?? ""),
    to: String(fields.get("to") ?? "") };
  busy = true;
  result = undefined;
  view();
  try {
    const response = await fetch("/api/availability", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), cache: "no-store" });
    const received = await response.json() as AvailabilityResponse;
    result = received.ok || received.error?.kind === "invalidInput" ? received : { ok: false, error: { kind: "unavailable" } };
  } catch { result = { ok: false, error: { kind: "unavailable" } }; }
  finally { busy = false; form.reset(); view(); }
}

view();
