import type { CallState } from "./model.ts";

/** Keep speech only while it can still be sent; terminal evidence needs status and IDs, not text. */
export function redactSettledContent(state: CallState): void {
  for (const [id, presentation] of Object.entries(state.presentations)) {
    if (presentation.kind === "transfer" || presentation.status === "pending" || presentation.status === "started" ||
        presentation.approvedText === "") continue;
    state.presentations[id] = { ...presentation, approvedText: "" };
  }
  if (state.lifecycle === "ended") state.callerMessages = [];
}
