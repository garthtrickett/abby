import { isDeepStrictEqual } from "node:util";
import { administrativeMemoActionRef } from "../cliniko/administrative-memo.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoClassAttendanceMove } from "./cliniko-class-attendance-move.ts";
import type { ClinikoClassMoveRequest, ClinikoClassMoveReport } from "./cliniko-class-attendance-move.ts";
import { retainAdministrativeMemo } from "./administrative-memo-retention.ts";
import type { ClinikoAdministrativeMemoConfig } from "./administrative-memo-retention.ts";

/** One movement's volatile report owner. Native provenance is necessary but
 * independent clinic producer/write grants remain necessary for retention.
 * Paused stages never spend the one original-action purpose. Finish/disposal
 * retains only the latest owned report, without continuing a clinical stage. */
export class ClinikoClassMoveMemo {
  readonly #config: ClinikoAdministrativeMemoConfig;
  readonly #source: ClinikoClassAttendanceMove["reportSource"];
  readonly #request: ClinikoClassMoveRequest;
  readonly #direction: "inbound" | "outbound";
  #last: ClinikoClassMoveReport | undefined;
  #inflight = false;
  #closed = false;
  #needsReview = false;
  #retained = false;
  constructor(config: ClinikoAdministrativeMemoConfig, mover: ClinikoClassAttendanceMove,
    request: ClinikoClassMoveRequest, direction: "inbound" | "outbound") {
    if (!(mover instanceof ClinikoClassAttendanceMove) || !isDeepStrictEqual(config.native.scope, request.scope) ||
        !administrativeMemoActionRef(request.actionId) || !["inbound", "outbound"].includes(direction)) throw Error("Invalid class memo source");
    this.#config = config; this.#source = mover.reportSource; this.#request = structuredClone(request); this.#direction = direction;
  }
  begin(): void { if (!this.#closed) this.#inflight = true; }
  observe(value: unknown): void {
    try {
      const found = this.#source(value), expected = this.#request;
      if (found && isDeepStrictEqual(found.request, expected) && found.businessId === this.#config.native.businessId &&
          found.credentialFingerprint === clinikoCredentialFingerprint(this.#config.native.apiKey) &&
          found.request.patientId === expected.patientId) this.#last = found;
    } catch { /* Optional evidence cannot replace clinical truth. */ }
    this.#inflight = false;
    if (this.#closed) this.#retain();
  }
  finish(needsReview = false): void {
    this.#closed = true; this.#needsReview ||= needsReview;
    if (!this.#inflight) this.#retain();
  }
  #retain(): void {
    if (this.#retained) return; this.#retained = true;
    const source = this.#last; this.#last = undefined;
    try {
      if (!source) return;
      const c = this.#config, q = source.request, o = source.outcome, recordedAt = c.native.clock!();
      const signed = c.authentication.sign({ actionRef: administrativeMemoActionRef(q.actionId)!, sourceActionRef: q.actionId,
        scope: q.scope, businessId: source.businessId, credentialFingerprint: source.credentialFingerprint, patientId: q.patientId,
        authorRef: c.native.authorRef, policy: c.native.policy, direction: this.#direction,
        outcome: { kind: "classMovementReported", appointmentRef: `cliniko:booking:${q.destination.sessionId}`,
          startsAt: q.destination.startsAt, endsAt: q.destination.endsAt,
          original: { appointmentRef: `cliniko:booking:${q.source.sessionId}`, attendeeRef: `cliniko:attendee:${q.source.attendeeId}`,
            startsAt: q.source.startsAt, endsAt: q.source.endsAt },
          ...(o.replacementAttendeeRef ? { replacementAttendeeRef: o.replacementAttendeeRef } : {}),
          progress: { original: o.original, replacement: o.replacement, caseAssociation: o.caseAssociation ?? "notApplicable" },
          completion: this.#needsReview || source.completion === "pending" ? "needsReview" : source.completion,
          verification: { basis: "nativeWorkflowReportBestEffort", reportedAt: source.reportedAt } },
        occurredAt: source.reportedAt, recordedAt });
      if (signed.ok) void retainAdministrativeMemo(c, signed.value).catch(() => {});
    } catch { /* No report or memo failure changes or repeats a clinical effect. */ }
  }
}
