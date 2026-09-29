import { randomUUID } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, TransitionFailure } from "../core/model.ts";
import type { TextReceptionFailure } from "./text-reception.ts";
import { TextReception } from "./text-reception.ts";

export type AvailabilityTextRequest = Readonly<{ text: string; from: string; to: string }>;
export type PreparedAvailabilityText = Readonly<{
  callId: string;
  presentationId: string;
  status: "shown" | "empty" | "failed";
  message: string;
}>;
export type AvailabilityTextFailure = TextReceptionFailure | Readonly<{ kind: "invalidInput" }>;

function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Shared text ingress for standalone and host-owned embedded storage. */
export class AvailabilityTextRunner {
  private readonly scope: LocationScope;
  private readonly reception: TextReception;
  private readonly clock: () => string;

  constructor(reception: TextReception, scope: LocationScope,
              clock: () => string = () => new Date().toISOString()) {
    this.scope = { ...scope };
    this.reception = reception;
    this.clock = clock;
  }

  async prepare(request: AvailabilityTextRequest): Promise<Result<PreparedAvailabilityText, AvailabilityTextFailure>> {
    if (!request || typeof request.text !== "string" || !request.text.trim() || request.text.length > 4_000 ||
        !date(request.from) || !date(request.to) ||
        Date.parse(`${request.to}T00:00:00Z`) - Date.parse(`${request.from}T00:00:00Z`) > 7 * 86_400_000 ||
        request.to < request.from) return err({ kind: "invalidInput" });
    let now: string;
    try { now = this.clock(); }
    catch { return err({ kind: "effectFailure" }); }
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) return err({ kind: "effectFailure" });
    const callId = randomUUID();
    const turnId = randomUUID();
    const started = await this.reception.startCall(callId, this.scope, now);
    if (!started.ok) return started;
    const response = await this.reception.checkAvailability(this.scope,
      { callId, turnId, text: request.text, quality: "clear", at: now }, request.from, request.to, now);
    if (!response.ok) return response;
    const answer = response.value.availabilityReads.find(item => item.turnId === turnId);
    const message = response.value.callerMessages.at(-1);
    const presentationId = response.value.pendingPresentationId;
    if (!answer || !message || !presentationId) return err({ kind: "effectFailure" });
    return ok({ callId, presentationId, status: answer.status, message });
  }

  /** The text transport calls this only after it accepts the response bytes. */
  async confirmWritten(prepared: Pick<PreparedAvailabilityText, "callId" | "presentationId">):
    Promise<Result<true, TransitionFailure>> {
    const acknowledged = await this.reception.acknowledgeTextPresentation(this.scope,
      prepared.callId, prepared.presentationId);
    return acknowledged.ok ? ok(true) : acknowledged;
  }
}
