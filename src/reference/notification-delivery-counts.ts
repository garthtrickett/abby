import type { NotificationReviewRow } from "./notification-review-shape.ts";

export const NOTIFICATION_DELIVERY_KEYS = ["sent", "notSent", "pending", "unconfirmed", "needsReview", "canceled"] as const;
const keys = NOTIFICATION_DELIVERY_KEYS;
export type NotificationDeliveryCounts = Readonly<Record<typeof keys[number], number>>;
const empty = (): Record<typeof keys[number], number> => ({ sent: 0, notSent: 0, pending: 0, unconfirmed: 0, needsReview: 0, canceled: 0 });
export function validNotificationDeliveryCounts(value: unknown): value is NotificationDeliveryCounts {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return false;
  const counts = value as Record<string, unknown>;
  return keys.every(key => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0);
}
export function notificationDeliveryCounts(rows: readonly NotificationReviewRow[] | undefined): NotificationDeliveryCounts | undefined {
  if (!rows?.length) return undefined;
  const counts = empty();
  for (const row of rows) {
    switch (row.status) {
      case "completed": counts[row.outcome === "sent" ? "sent" : "notSent"] += 1; break;
      case "pending": counts.pending += 1; break;
      case "possiblySent": case "uncertain": counts.unconfirmed += 1; break;
      case "needsReview": counts.needsReview += 1; break;
      case "canceled": counts.canceled += 1; break;
    }
  }
  return counts;
}
export function sumNotificationDeliveryCounts(rows: readonly (NotificationDeliveryCounts | undefined)[]): NotificationDeliveryCounts | undefined {
  if (!rows.some(row => row !== undefined)) return undefined;
  const counts = empty();
  for (const row of rows) if (row) for (const key of keys) counts[key] += row[key];
  return counts;
}
