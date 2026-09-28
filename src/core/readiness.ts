import { err } from "./model.ts";
import type { LocationScope, Result } from "./model.ts";

export const READINESS_REQUIREMENTS = ["hostPermissions", "selectedLocation", "approvedKnowledge", "approvedGreeting", "bookableOffers",
  "staffDestination", "afterHoursDestination", "notificationOwner", "fallbackRoute", "mediaTestCall"] as const;
export type ReadinessRequirement = typeof READINESS_REQUIREMENTS[number];
export type ReadinessFailure = Readonly<{ kind: "readinessFailed"; missing: readonly ReadinessRequirement[] }>;

/** The embedding host supplies current, scoped evidence; callers cannot submit it through a setting command. */
export type AutomationReadiness = (scope: LocationScope) => Promise<Result<true, ReadinessFailure>>;

export const unprovenReadiness: AutomationReadiness = async () =>
  err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
