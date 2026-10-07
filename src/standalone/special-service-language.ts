import type { MenuClarificationReason } from "../core/model.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
/** Negative service routing only. An individual appointment approval cannot
 * authorize a home visit, visit-mode switch or a different source practitioner. */
export function specialServiceLanguage(text: string): MenuClarificationReason | undefined {
 const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
 if (!value || value.length > 350 || /[\n\r"“”]/.test(value)) return undefined;
 if (/^(?:i need a home visit|can you book a home visit for foot treatment|cancel my home visit appointment)$/.test(value)) return "serviceArrangementUnavailable";
 if (/^(?:please change my appointment to (?:telehealth|in person)|can i attend my appointment virtually)$/.test(value)) return "changeUnsupported";
 if (/^move my appointment to another practitioner$/.test(value)) return "searchPreferenceUnavailable";
 const other = /^can i reschedule with (.+?) instead$/.exec(value)?.[1];
 if (other && !/\b(?:and|or|cancel|book|move|reschedule)\b/.test(other) && normalizedSpokenName(other)) return "searchPreferenceUnavailable";
 return undefined;
}
