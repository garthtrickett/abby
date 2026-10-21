import { randomUUID } from "node:crypto";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { clinicDateAt } from "./clinic-clock.ts";

export type ReviewedSendFailure = Readonly<{ kind:
  "invalidReview" | "attemptConsumed" | "authorityLost" | "reviewUnavailable" |
  "reviewUncertain" | "mutationUncertain" | "disconnected" }>;
export type ReviewedSendPorts<Value> = Readonly<{
  /** Trusted host checks live confirmation, proof, exact target/terms, policy and write-stop state.
   * Called both before the recall and immediately before the clinical send. Never supplied by the model. */
  authorize(request: ClinikoReviewRequest, signal: AbortSignal): Promise<boolean>;
  /** One possible clinical send. Returns the operation's own inspected outcome; no receipt is minted here. */
  send(request: ClinikoReviewRequest, signal: AbortSignal): Promise<Value>;
  /** Individual/class creation only: an exact acknowledgement already validated inside send.
   * No headers, pending parse or outcome from another operation may use this path. */
  acknowledgedBooking?(): Value | undefined;
}>;
type Config = Readonly<{
  scope: LocationScope;
  businessId: string;
  credentialFingerprint: string;
  policyVersion: string;
  timeZone: string;
  recallTypeId: string;
  writer: ClinikoRecallWriter;
  clock?: () => number;
  deadlineMs?: number;
}>;
export type ClinikoReviewedChangeSource = Readonly<{ marker: string; recallRef: string;
  request: ClinikoReviewRequest & Readonly<{ operation: Extract<ClinikoReviewRequest["operation"], { kind: "cancel" | "reschedule" | "classCancel" }> }> }>;

async function untilAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value | undefined> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => { resolve(undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve(undefined);
  });
  try { return await Promise.race([pending, aborted]); }
  catch { return undefined; }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** One confirmed action, owned by one live call. Review acknowledgment precedes any clinical send.
 * No persistence, retry, compensation, recovery dispatch or standalone activation is supplied here. */
export class ClinikoReviewedSend {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #consumed = false;
  readonly #changeSources = new WeakMap<object, Readonly<{ source: ClinikoReviewedChangeSource; outcome: unknown }>>();

  constructor(config: Config) {
    const selection = config.writer?.selection();
    const scope = config.scope;
    if (!scope || ![scope.tenantId, scope.clinicId, scope.locationId, config.policyVersion]
        .every(value => typeof value === "string" && !!value.trim() && value.length <= 256) ||
        !validClinikoId(config.businessId) || !validClinikoId(config.recallTypeId) ||
        !/^[a-f0-9]{64}$/.test(config.credentialFingerprint) || !selection ||
        typeof config.timeZone !== "string" || !config.timeZone || config.timeZone.length > 128 ||
        selection.scope.tenantId !== scope.tenantId || selection.scope.clinicId !== scope.clinicId ||
        selection.credentialFingerprint !== config.credentialFingerprint ||
        (config.clock !== undefined && typeof config.clock !== "function") ||
        (config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) ||
          config.deadlineMs < 1 || config.deadlineMs > 30_000))) throw new TypeError("invalid reviewed send configuration");
    try { new Intl.DateTimeFormat("en", { timeZone: config.timeZone }); }
    catch { throw new TypeError("invalid reviewed send configuration"); }
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...scope }) });
    Object.defineProperty(this, "changeSource", { value: this.changeSource.bind(this) });
  }

  sharesRequestBudget(budget: ClinikoRequestBudget): boolean { return this.#config.writer.sharesRequestBudget(budget); }
  /** Original acknowledged native review identity; not a clinical outcome. */
  changeSource(result: unknown): ClinikoReviewedChangeSource | undefined {
    try {
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).sort().join(",") !== "outcome,recallRef") return;
      const found = this.#changeSources.get(result), value = result as { recallRef?: unknown; outcome?: unknown };
      return found && value.recallRef === found.source.recallRef && value.outcome === found.outcome ? found.source : undefined;
    } catch { return; }
  }
  #changeResult<Value>(recallRef: string, marker: string, request: ClinikoReviewRequest, outcome: Value) {
    const value = { recallRef, outcome };
    if (request.operation.kind === "cancel" || request.operation.kind === "reschedule" || request.operation.kind === "classCancel") {
      try {
        const operation = structuredClone(request.operation);
        if (operation.kind === "classCancel" && operation.pass) Object.freeze(operation.pass);
        const copy = Object.freeze({ ...request, scope: Object.freeze({ ...request.scope }), operation: Object.freeze(operation) });
        this.#changeSources.set(value, Object.freeze({ source: Object.freeze({ recallRef, marker, request: copy }), outcome }));
      } catch { /* Optional memo provenance cannot alter the existing reviewed-send result. */ }
    }
    return ok(value);
  }

  async run<Value>(confirmed: ClinikoReviewRequest, ports: ReviewedSendPorts<Value>, external: AbortSignal):
    Promise<Result<Readonly<{ recallRef: string; outcome: Value }>, ReviewedSendFailure>> {
    if (this.#lifetime.signal.aborted || external.aborted) return err({ kind: "disconnected" });
    if (this.#consumed) return err({ kind: "attemptConsumed" });
    // Claim before any asynchronous boundary. A retry requires a new explicit caller action,
    // not another call to this gate or a recovered provider record.
    this.#consumed = true;
    const config = this.#config;
    const marker = randomUUID();
    const encoded = encodeClinikoReview(marker, confirmed);
    if (!encoded.ok || typeof ports?.authorize !== "function" || typeof ports?.send !== "function") {
      return err({ kind: "invalidReview" });
    }
    // Parsing creates a private copy of the exact envelope before any awaited host callback.
    const decoded = decodeClinikoReview(encoded.value);
    if (!decoded.ok) return err({ kind: "invalidReview" });
    const request = decoded.value.request;
    Object.freeze(request.scope); Object.freeze(request.operation); Object.freeze(request);
    let now: number;
    try { now = (config.clock ?? Date.now)(); } catch { return err({ kind: "invalidReview" }); }
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 || Math.abs(now - Date.parse(request.createdAt)) > 30_000 ||
        !sameScope(request.scope, config.scope) || request.businessId !== config.businessId ||
        request.credentialFingerprint !== config.credentialFingerprint || request.policyVersion !== config.policyVersion ||
        request.timeZone !== config.timeZone) return err({ kind: "invalidReview" });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), config.deadlineMs ?? 30_000);
    const signal = AbortSignal.any([external, this.#lifetime.signal, deadline.signal]);
    const stopped = (): ReviewedSendFailure => ({ kind:
      this.#lifetime.signal.aborted || external.aborted ? "disconnected" : "authorityLost" });
    try {
      const before = await untilAbort(Promise.resolve().then(() => ports.authorize(request, signal)), signal);
      if (before !== true || signal.aborted) return err(stopped());
      const opened = await untilAbort(config.writer.openOnce({ scope: config.scope, patientId: request.patientId,
        recallTypeId: config.recallTypeId, recallAt: clinicDateAt(config.timeZone, new Date(now)), marker,
        summary: encoded.value.split("\n").slice(1).join("\n") }, signal), signal);
      if (!opened) return err({ kind: "reviewUncertain" });
      if (!opened.ok) return err({ kind: "reviewUnavailable" });
      if (opened.value.kind !== "accepted") return err({ kind: "reviewUncertain" });
      if (signal.aborted) return err(stopped());
      const after = await untilAbort(Promise.resolve().then(() => ports.authorize(request, signal)), signal);
      if (after !== true || signal.aborted) return err(stopped());
      // No await between the last stop check and initiating the one possible send.
      // Once invoked, a timeout/throw cannot prove that the provider did not commit.
      const sent = ports.send(request, signal);
      const outcome = await untilAbort(sent, signal);
      const acknowledged = request.operation.kind === "book" || request.operation.kind === "classBook" ? ports.acknowledgedBooking?.() : undefined;
      if (acknowledged !== undefined) return ok({ recallRef: opened.value.recallRef, outcome: acknowledged });
      if (outcome === undefined || signal.aborted) return err({ kind: "mutationUncertain" });
      return this.#changeResult(opened.value.recallRef, marker, request, outcome);
    } catch { return err({ kind: "mutationUncertain" }); }
    finally { clearTimeout(timer); }
  }

  close(): void { this.#lifetime.abort(); }
}
