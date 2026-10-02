import { html } from "lit-html";
import { NOTIFICATION_LABELS } from "../../core/notification-policy.ts";
import type { NotificationReviewRow } from "../../reference/notification-review-shape.ts";
import type { NotificationDeliveryCounts } from "../../reference/notification-delivery-counts.ts";

const statuses = { pending: "Waiting to send", possiblySent: "Delivery unconfirmed", uncertain: "Delivery unconfirmed",
  needsReview: "Needs review", canceled: "Canceled before send" };
const reasons = { suppressionUnproven: "Native send suppression unproven", emergencyStop: "Emergency stop", hostUnavailable: "Sender unavailable" };
export function notificationDeliveryView(rows: readonly NotificationReviewRow[] | undefined) {
  if (!rows?.length) return "";
  return html`<h3>Managed notification delivery</h3><ul aria-label="Notification delivery">${rows.map(item => html`<li>
    ${NOTIFICATION_LABELS[item.kind]} · ${item.owner === "abby" ? "Abby" : "Host"} ·
    ${item.status === "completed" ? item.outcome === "sent" ? "Sent" : "Not sent" : statuses[item.status]}
    ${item.blockedReason ? ` · ${reasons[item.blockedReason]}` : ""}</li>`)}</ul>`;
}
export function notificationCountsView(counts: NotificationDeliveryCounts | undefined) {
  return counts ? html`<span aria-label="Managed notification outcomes">Notifications:
    ${counts.sent} sent · ${counts.notSent} not sent · ${counts.pending} pending ·
    ${counts.unconfirmed} unconfirmed · ${counts.needsReview} need review · ${counts.canceled} canceled</span>` : "";
}
