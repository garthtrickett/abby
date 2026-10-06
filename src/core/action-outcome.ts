import type { ActionRequest } from "./model.ts";

export function confirmedActionText(kind: ActionRequest["kind"]): string {
  switch (kind) {
    case "book": return "Your booking is confirmed.";
    case "cancel": return "Your appointment cancellation is confirmed.";
    case "reschedule": return "Your appointment move is confirmed.";
    case "intake": return "Your details were saved. No appointment is confirmed yet.";
  }
}
