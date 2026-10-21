/** Shared case identities only; each worker must still execute its actual
 * admitted workflow and the parent independently checks observed native rows. */
export const administrativeMemoRecoveryCases = {
  class: { apiKey: "synthetic-class-au5", review: "classBook", outcome: "classBookingConfirmed", mutations: ["POST /v1/attendees"] },
  individual: { apiKey: "synthetic-session-au5", review: "book", outcome: "bookingConfirmed", mutations: ["POST /v1/individual_appointments"] },
  cancel: { apiKey: "synthetic-session-au5", review: "cancel", outcome: "cancellationObserved", mutations: ["PATCH /v1/individual_appointments/91/cancel"] },
  reschedule: { apiKey: "synthetic-session-au5", review: "reschedule", outcome: "reschedulingObserved", mutations: ["PATCH /v1/individual_appointments/91"] },
  classCancel: { apiKey: "synthetic-class-au5", review: "classCancel", outcome: "classCancellationObserved", mutations: ["PATCH /v1/attendees/101/cancel"] },
  classCancelReleaseOne: { apiKey: "synthetic-class-au5", review: "classCancel", outcome: "classCancellationObserved", mutations: ["PATCH /v1/attendees/101/cancel"] },
  classCancelUnchanged: { apiKey: "synthetic-class-au5", review: "classCancel", outcome: "classCancellationObserved", mutations: ["PATCH /v1/attendees/101/cancel"] },
  classCancelConsumeOne: { apiKey: "synthetic-class-au5", review: "classCancel", outcome: "classCancellationObserved", mutations: ["PATCH /v1/attendees/101/cancel"] },
  classMove: { apiKey: "synthetic-class-au5", review: "classMove", outcome: "classMovementReported", mutations: ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel"] },
  classMovePartial: { apiKey: "synthetic-class-au5", review: "classMove", outcome: "classMovementReported", mutations: ["POST /v1/attendees"] },
  classPassMove: { apiKey: "synthetic-class-au5", review: "classMove", outcome: "classMovementReported", mutations: ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel", "PATCH /v1/attendees/401"] },
  classPassMovePartial: { apiKey: "synthetic-class-au5", review: "classMove", outcome: "classMovementReported", mutations: ["POST /v1/attendees"] }
} as const;
export type AdministrativeMemoRecoveryFamily = keyof typeof administrativeMemoRecoveryCases;
