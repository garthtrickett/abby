import type { CallRuntime } from "../core/runtime.ts";

/** Synthetic/text ports return playback; a voice port may already have recorded
 * the exact transport receipt. Neither path may overwrite a terminal failure. */
export async function completePrivateResendPresentation(runtime: CallRuntime, callId: string, presentationId: string,
  sessionId: string, played: boolean, now: string): Promise<boolean> {
  const state = await runtime.read(callId);
  if (!state.ok) return false;
  const presentation = state.value.presentations[presentationId];
  if (presentation?.kind !== "notice" || presentation.approvedText !== "") return false;
  if (presentation.status === "started") {
    const resolved = await runtime.resolvePresentation(callId, presentationId, played ? "played" : "failed", sessionId, now);
    return resolved.ok && played;
  }
  return played && presentation.status === "played";
}
