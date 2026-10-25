import { READINESS_REQUIREMENTS } from "../../core/readiness.ts";
import type { ReadinessRequirement } from "../../core/readiness.ts";

const guidance: Readonly<Record<ReadinessRequirement, Readonly<{ label: string; next: string }>>> = {
  hostPermissions: { label: "host permissions", next: "Ask your Abby administrator to verify the clinic's current permissions." },
  selectedLocation: { label: "a selected location", next: "Have an authorized clinic administrator confirm the intended clinic location." },
  approvedKnowledge: { label: "approved clinic information", next: "Review and approve the current public clinic information." },
  approvedGreeting: { label: "an approved greeting", next: "Review and approve the current clinic greeting." },
  bookableOffers: { label: "booking setup", next: "Have the clinic owner verify its approved booking catalogue and current offers." },
  staffDestination: { label: "staff destination", next: "Confirm the approved staff destination and its delivery evidence." },
  afterHoursDestination: { label: "after-hours destination", next: "Confirm the clinic's approved after-hours handling and destination." },
  notificationOwner: { label: "notification owner", next: "Confirm who owns each required notification and verify delivery." },
  voiceProfile: { label: "approved locale and voice", next: "Ask your Abby administrator to verify the approved locale, voice and required speech-quality evidence." },
  fallbackRoute: { label: "tested fallback route", next: "Verify the clinic-approved fallback route with a supervised test." },
  mediaTestCall: { label: "passed media test call", next: "Ask your Abby administrator to verify a supervised representative call test." },
};

/** Explain current server failure evidence; this text never grants readiness or changes settings. */
export function automationReadinessFailureMessage(missing: unknown): string {
  const values: readonly unknown[] = Array.isArray(missing) ? missing : [];
  const known = READINESS_REQUIREMENTS.filter(requirement => values.includes(requirement));
  const hasUnknown = values.length === 0 || values.some(value =>
    !READINESS_REQUIREMENTS.includes(value as ReadinessRequirement));
  const labels = known.map(requirement => guidance[requirement].label);
  const next = known.map(requirement => guidance[requirement].next);
  if (hasUnknown) {
    labels.push(known.length ? "other readiness evidence" : "readiness evidence");
    next.push("Ask an authorized clinic operator to recheck the clinic's current readiness evidence.");
  }
  return `Clinic setup incomplete: ${labels.join(", ")}. Next: ${next.join(" ")} Automation cannot be enabled until the clinic's readiness checks pass.`;
}
