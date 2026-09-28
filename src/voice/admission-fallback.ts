import { ok } from "../core/model.ts";
import type { AdmissionResult, Result, TransitionFailure } from "../core/model.ts";
import { CallAdmissionService, callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall, RouteFailure } from "./admission.ts";

export type FallbackOutcome =
  | Readonly<{ kind: "connected"; providerConnectionRef: string }>
  | Readonly<{ kind: "notConfigured" | "failed" | "unproven" }>;
export type FallbackRequest = Readonly<{
  callId: string;
  accountRef: string;
  providerCallRef: string;
  dialedNumber: string;
}>;
export type FallbackPort = Readonly<{
  // The provider route must be independently configured and replay-safe by callId.
  attempt(request: FallbackRequest): Promise<FallbackOutcome>;
}>;
export type AdmissionFailureAlert = Readonly<{
  callId: string;
  reason: TransitionFailure["kind"] | RouteFailure["kind"];
  fallback: FallbackOutcome;
}>;
export type OperationalAlertPort = Readonly<{
  notify(alert: AdmissionFailureAlert): Promise<void>;
}>;
export type AdmissionRoutingResult =
  | Readonly<{ kind: "admitted"; admission: AdmissionResult }>
  | Readonly<{ kind: "fallback"; callId: string; outcome: FallbackOutcome; alerted: boolean }>;

function eligibleForFallback(kind: TransitionFailure["kind"] | RouteFailure["kind"]): boolean {
  return kind === "routeUnavailable" || kind === "unknownNumber" || kind === "ambiguousClinic" || kind === "locationChoiceRequired" ||
    kind === "automationDisabled" || kind === "readinessFailed" || kind === "storageFailure" || kind === "storageCorrupt";
}

function decodeFallbackOutcome(value: unknown): FallbackOutcome {
  if (typeof value !== "object" || value === null) return { kind: "unproven" };
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "connected" && typeof outcome.providerConnectionRef === "string" && outcome.providerConnectionRef.trim()) {
    return { kind: "connected", providerConnectionRef: outcome.providerConnectionRef };
  }
  if (outcome.kind === "notConfigured" || outcome.kind === "failed" || outcome.kind === "unproven") return { kind: outcome.kind };
  return { kind: "unproven" };
}

export class AdmissionFallbackCoordinator {
  private readonly admission: CallAdmissionService;
  private readonly fallback: FallbackPort;
  private readonly alert: OperationalAlertPort;

  constructor(
    admission: CallAdmissionService,
    fallback: FallbackPort,
    alert: OperationalAlertPort,
  ) {
    this.admission = admission;
    this.fallback = fallback;
    this.alert = alert;
  }

  async begin(event: AuthenticatedInboundCall): Promise<Result<AdmissionRoutingResult, TransitionFailure | RouteFailure>> {
    const admitted = await this.admission.begin(event);
    if (admitted.ok) return ok({ kind: "admitted", admission: admitted.value });
    if (!eligibleForFallback(admitted.error.kind)) return admitted;

    const request: FallbackRequest = {
      callId: callIdFor(event.key),
      accountRef: event.key.accountRef,
      providerCallRef: event.key.providerCallRef,
      dialedNumber: event.dialedNumber,
    };
    let outcome: FallbackOutcome;
    try { outcome = decodeFallbackOutcome(await this.fallback.attempt(request)); }
    catch { outcome = { kind: "unproven" }; }
    let alerted = false;
    try {
      await this.alert.notify({ callId: request.callId, reason: admitted.error.kind, fallback: outcome });
      alerted = true;
    } catch { /* fallback outcome does not depend on the alert channel */ }
    return ok({ kind: "fallback", callId: request.callId, outcome, alerted });
  }
}
