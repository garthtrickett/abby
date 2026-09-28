import type { TransitionFailure } from "./model.ts";
import type { ReadinessFailure } from "./readiness.ts";

export type WriteStopFailure = TransitionFailure | ReadinessFailure;

export type InFlightWrite = Readonly<{
  effectId: string;
  callId: string;
  actionKey: string;
  status: "possiblySent" | "uncertain";
}>;

export type WriteStopStatus = Readonly<{
  stopped: boolean;
  version: string;
  actorRef?: string;
  reason?: string;
  changedAt?: string;
  inFlight: readonly InFlightWrite[];
  nextAfterEffectId?: string;
}>;

export type WriteStopAuditEntry = Readonly<{
  version: string;
  stopped: boolean;
  actorRef: string;
  reason: string;
  changedAt: string;
}>;
export type WriteStopAuditPage = Readonly<{ entries: readonly WriteStopAuditEntry[]; nextAfterVersion?: number }>;
