import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, TransitionFailure } from "../core/model.ts";
import type Database from "../storage/generated/Database.ts";
import type { TextReceptionFailure } from "../reference/text-reception.ts";
import { createStandaloneTextComposition } from "./text-composition.ts";

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

/** Local text ingress. Caller words and offered times exist only in the returned, transient presentation. */
export class StandaloneAvailabilityTextRunner {
  private readonly scope: LocationScope;
  private readonly reception: ReturnType<typeof createStandaloneTextComposition>["reception"];
  private readonly clock: () => string;

  constructor(db: Kysely<Database>, scope: LocationScope, reader: ClinikoAvailabilityReader,
              clock: () => string = () => new Date().toISOString()) {
    this.scope = { ...scope };
    this.reception = createStandaloneTextComposition(db, reader).reception;
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
