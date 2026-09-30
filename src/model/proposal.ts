import { err, ok } from "../core/model.ts";
import type { FinalCallerTurn, LocationScope, Result } from "../core/model.ts";

export const MODEL_PROPOSAL_VERSION = 1 as const;

/** A suggestion from a model. No variant is a host command or confirmation proof. */
export type ModelProposal =
  | Readonly<{ schemaVersion: 1; kind: "answer"; sourceRefs: readonly string[]; proposedText: string }>
  | Readonly<{ schemaVersion: 1; kind: "lookup"; target: "patient" | "appointment" | "offer";
      statedName?: string; statedDate?: string; requestedService?: string; requestedLocationId?: string }>
  | Readonly<{ schemaVersion: 1; kind: "action"; operation: "intake" | "book" | "cancel" | "reschedule";
      targetRef?: string; requestedService?: string; requestedTime?: string }>
  | Readonly<{ schemaVersion: 1; kind: "handoff"; reason: "callerRequested" | "unsupported" }>;

export type ModelFailure = Readonly<{ kind: "malformed" | "unavailable" | "deadlineExceeded" }>;

/** This input is transient. Callers must apply consent and retention rules before persisting it. */
export type ModelInput = Readonly<{
  scope: LocationScope;
  turn: FinalCallerTurn;
  /** Bounded prior caller turns from this scoped call; never identity or action evidence. */
  priorCallerTurns?: readonly string[];
  knowledge: readonly Readonly<{ sourceRef: string; approvedText: string }>[];
  conversationRevision: number;
  policyVersion: string;
  promptVersion: string;
}>;

/** Applies the same transient context bound at task preparation and provider egress. */
export function validPriorCallerTurns(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 3 &&
    value.every(text => typeof text === "string" && !!text.trim() && text.length <= 4_000) &&
    value.reduce((length: number, text: string) => length + text.length, 0) <= 4_000;
}

export interface RawModelPort {
  propose(input: ModelInput, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

function optionalBounded(value: unknown, max: number): value is string | undefined {
  return value === undefined || bounded(value, max);
}

function validDate(value: unknown): value is string {
  if (!bounded(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validInstant(value: unknown): value is string {
  if (!bounded(value, 40)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const normalized = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (normalized.toISOString().slice(0, 19) !== wall) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone!.slice(1, 3));
    const offsetMinute = Number(zone!.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return true;
}

const handoffReasons = ["callerRequested", "unsupported"] as const;

function decodeShape(raw: unknown): Result<ModelProposal, ModelFailure> {
  const value = record(raw);
  if (!value || value.schemaVersion !== MODEL_PROPOSAL_VERSION || typeof value.kind !== "string") return err({ kind: "malformed" });

  switch (value.kind) {
    case "answer": {
      if (!keys(value, ["schemaVersion", "kind", "sourceRefs", "proposedText"]) ||
          !Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > 8 ||
          !value.sourceRefs.every(ref => bounded(ref, 256)) ||
          new Set(value.sourceRefs).size !== value.sourceRefs.length || !bounded(value.proposedText, 2_000)) return err({ kind: "malformed" });
      return ok({ schemaVersion: 1, kind: "answer", sourceRefs: value.sourceRefs as string[], proposedText: value.proposedText });
    }
    case "lookup": {
      if (!keys(value, ["schemaVersion", "kind", "target"],
        ["statedName", "statedDate", "requestedService", "requestedLocationId"]) ||
          !["patient", "appointment", "offer"].includes(value.target as string) ||
          !optionalBounded(value.statedName, 120) ||
          (value.statedDate !== undefined && !validDate(value.statedDate)) ||
          !optionalBounded(value.requestedService, 256) || !optionalBounded(value.requestedLocationId, 256)) return err({ kind: "malformed" });
      return ok(value as ModelProposal);
    }
    case "action": {
      if (!keys(value, ["schemaVersion", "kind", "operation"],
        ["targetRef", "requestedService", "requestedTime"]) ||
          !["intake", "book", "cancel", "reschedule"].includes(value.operation as string) ||
          !optionalBounded(value.targetRef, 256) || !optionalBounded(value.requestedService, 256) ||
          (value.requestedTime !== undefined && !validInstant(value.requestedTime))) return err({ kind: "malformed" });
      return ok(value as ModelProposal);
    }
    case "handoff": {
      if (!keys(value, ["schemaVersion", "kind", "reason"]) ||
          !handoffReasons.includes(value.reason as typeof handoffReasons[number])) return err({ kind: "malformed" });
      return ok(value as ModelProposal);
    }
    default:
      return err({ kind: "malformed" });
  }
}

/** The sole boundary where untrusted model JSON becomes a typed proposal. */
export function decodeModelProposal(raw: unknown): Result<ModelProposal, ModelFailure> {
  try { return decodeShape(raw); }
  catch { return err({ kind: "malformed" }); }
}

export class ModelIngress {
  private readonly port: RawModelPort;

  constructor(port: RawModelPort) { this.port = port; }

  async propose(input: ModelInput, deadlineMs: number): Promise<Result<ModelProposal, ModelFailure>> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) return err({ kind: "malformed" });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Result<ModelProposal, ModelFailure>>(resolve => {
      timer = setTimeout(() => {
        resolve(err({ kind: "deadlineExceeded" }));
        controller.abort();
      }, deadlineMs);
    });
    const proposal = Promise.resolve().then(() => this.port.propose(input, controller.signal))
      .then(decodeModelProposal)
      .catch(() => err({ kind: "unavailable" } as const));
    try { return await Promise.race([proposal, deadline]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
