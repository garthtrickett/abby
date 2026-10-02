import { NOTIFICATION_KINDS } from "../core/notification-policy.ts";
import type { NotificationKind, NotificationOwner } from "../core/notification-policy.ts";

export type NotificationReviewRow = Readonly<{ kind: NotificationKind; owner: NotificationOwner }> & (
  Readonly<{ status: "pending" | "possiblySent"; outcome?: never; blockedReason?: never }> |
  Readonly<{ status: "completed"; outcome: "sent" | "definitiveUnsent"; blockedReason?: never }> |
  Readonly<{ status: "uncertain" | "needsReview"; outcome: "unknown"; blockedReason?: never }> |
  Readonly<{ status: "needsReview"; outcome?: never; blockedReason: "suppressionUnproven" }> |
  Readonly<{ status: "canceled"; outcome?: never; blockedReason: "hostUnavailable" | "emergencyStop" }>
);
/** Shared wire validation prevents a missing outcome from becoming a sent or unsent claim. */
export function validNotificationReviewRow(value: unknown): value is NotificationReviewRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["kind", "owner", "status", "outcome", "blockedReason"].includes(key)) ||
    !NOTIFICATION_KINDS.includes(row.kind as NotificationKind) || !["host", "abby"].includes(row.owner as string)) return false;
  switch (row.status) {
    case "pending": case "possiblySent": return row.outcome === undefined && row.blockedReason === undefined;
    case "completed": return (row.outcome === "sent" || row.outcome === "definitiveUnsent") && row.blockedReason === undefined;
    case "uncertain": return row.outcome === "unknown" && row.blockedReason === undefined;
    case "needsReview": return row.blockedReason === "suppressionUnproven" ? row.outcome === undefined
      : row.blockedReason === undefined && row.outcome === "unknown";
    case "canceled": return row.outcome === undefined && ["hostUnavailable", "emergencyStop"].includes(row.blockedReason as string);
    default: return false;
  }
}
