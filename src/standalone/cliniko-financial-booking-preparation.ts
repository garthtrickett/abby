import { createHash, createPublicKey, KeyObject, randomUUID } from "node:crypto";
import { digestActionRequest } from "../core/digest.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { LocationScope } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoFinancialRecordRetainer } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordAuthority, FinancialRecordRetentionConfig } from "../cliniko/financial-record-retention.ts";
import type { ClinikoFinancialReviewPermission } from "../cliniko/financial-review-read.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import { ClinikoFinancialReviewReader } from "../cliniko/financial-review-read.ts";
import { ClinikoFinancialBookingCapture } from "../cliniko/financial-booking-capture.ts";
import type { ClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import { encodeClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import type { FinancialBookingConsent } from "../cliniko/financial-booking-observation.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { PreparedClinikoBooking } from "./cliniko-booking-authority.ts";
import { sameScope } from "./appointment-change-authority.ts";

export type FinancialBookingSelection = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; verificationRef: string; offerRef: string;
  patientId: string; practitionerId: string; appointmentTypeId: string; businessId: string; credentialFingerprint: string;
  startsAt: string; endsAt: string; timeZone: string; expiresAt: string; clinicalDigest: string;
}>;
export type FinancialBookingAssessment = Readonly<{ kind: "notRequired"; version: string; expiresAt: string }> | Readonly<{
  kind: "required"; payment: ClinikoFinancialIntent["payment"]; recipient: ClinikoFinancialIntent["recipient"];
  approvedTerms: string; reviewDate: string; expiresAt: string;
}>;
export type FinancialBookingPolicy = Readonly<{
  quote(selection: FinancialBookingSelection, signal: AbortSignal): Promise<FinancialBookingAssessment | undefined>;
  current(selection: FinancialBookingSelection, assessment: FinancialBookingAssessment, signal: AbortSignal): Promise<boolean>;
  currentForSend(selection: FinancialBookingSelection, assessment: FinancialBookingAssessment, signal: AbortSignal): boolean;
}>;
export type FinancialBookingPreparationConfig = Readonly<{
  native: FinancialRecordRetentionConfig; sourceAuthorized: ClinikoFinancialReviewPermission["allows"]; authority: FinancialRecordAuthority; barrier: FinancialEffectBarrier;
  privateKey: KeyObject; policy: FinancialBookingPolicy;
  presentation: Readonly<{ play(text: string, signal: AbortSignal, canPresent: () => boolean): Promise<Readonly<{ presentationRef: string; playedAt: string }> | undefined> }>;
  /** Financial retention after an ACK is owned by the service, not the call. */
  financialSignal: AbortSignal; fetchPort?: typeof fetch;
}>;
export type FinancialBookingCapture = Readonly<{ kind: "notRequired" }> | Readonly<{
  kind: "required"; capture: ClinikoFinancialBookingCapture; intent: ClinikoFinancialIntent; recallRef: string; reviewDate: string;
}>;
type Pending = { fence: object; selection: FinancialBookingSelection; assessment: FinancialBookingAssessment; marker: string;
  intent?: ClinikoFinancialIntent; recallRef?: string; consent?: FinancialBookingConsent;
  readback?: Readonly<{ segments: readonly string[]; receipts: { presentationRef: string; playedAt: string }[] }>;
  phase: "notRequired" | "unplayed" | "playing" | "awaiting" | "accepted" | "declined" };
function freeze<T>(v: T): T { if (v !== null && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Each clip keeps the existing private-prompt deadline. A new, post-play digit
 * requests the next clip; only the digit after the final clip can consent. */
function financialReadback(intent: ClinikoFinancialIntent, assessment: Extract<FinancialBookingAssessment, { kind: "required" }>, timeZone: string): readonly string[] | undefined {
  const deadline = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date(intent.payment.deadline));
  const text = `The clinic requires a post-booking deposit of ${intent.payment.currency.toUpperCase()} ${(intent.payment.amount / 100).toFixed(2)}, payable by ${deadline} in the clinic time zone. With your permission, the clinic will email a secure Stripe payment link to ${intent.recipient.address}. ${assessment.approvedTerms} This does not pay now or reserve the time.`;
  const parts: string[] = []; let part = "", count = 0;
  for (const word of text.split(/\s+/)) {
    // An unusually long address/word needs a separately qualified readback.
    if (word.length > 160) return undefined;
    if (part && (part.length + word.length + 1 > 160 || count >= 24)) { parts.push(part); part = ""; count = 0; }
    part += `${part ? " " : ""}${word}`; count++;
  }
  if (part) parts.push(part);
  if (!parts.length || parts.length > 14) return undefined;
  return Object.freeze([...parts.map(p => `${p} Press 1 to hear the next part, or 2 to decline.`),
    "The financial terms are complete. Press 1 to agree to these terms and the payment email, or 2 to decline. If you agree, say continue booking. A separate booking confirmation follows."]);
}

/** Call-private quote/consent owner. Money, recipient, text and receipt never enter
 * SAM/action/local storage. Only the real producer later signs the receipt into
 * its native booking observation. This grants no clinical or money effect. */
export class ClinikoFinancialBookingPreparation {
  readonly #config: FinancialBookingPreparationConfig;
  readonly #call: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; ledger: LedgerStore }>;
  readonly #records: ClinikoFinancialRecordRetainer;
  readonly #reader: ClinikoFinancialReviewReader;
  readonly #lifetime = new AbortController();
  #quoteLifetime = new AbortController();
  #pending: Pending | undefined;
  #busy = false;
  constructor(config: FinancialBookingPreparationConfig, call: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; ledger: LedgerStore }>) {
    if (!(config.privateKey instanceof KeyObject) || config.privateKey.type !== "private" || config.privateKey.asymmetricKeyType !== "ed25519" ||
        createPublicKey(config.privateKey).export({ type: "spki", format: "der" }).toString("hex") !== config.native.producer.publicKey.export({ type: "spki", format: "der" }).toString("hex") ||
        !(config.financialSignal instanceof AbortSignal) || config.financialSignal.aborted || typeof config.sourceAuthorized !== "function" || !sameScope(config.native.scope, call.scope) ||
        typeof config.policy?.quote !== "function" || typeof config.policy.current !== "function" || typeof config.policy.currentForSend !== "function" || typeof config.presentation?.play !== "function") throw new TypeError("Invalid financial booking preparation");
    const records = ClinikoFinancialRecordRetainer.create(config.native, config.authority, config.barrier, config.fetchPort);
    const reader = ClinikoFinancialReviewReader.create(config.native, { allows: config.sourceAuthorized.bind(config) }, config.fetchPort);
    if (!records.ok || !reader.ok) throw new TypeError("Invalid financial booking preparation");
    this.#records = records.value; this.#reader = reader.value;
    this.#call = Object.freeze({ ...call, scope: Object.freeze({ ...call.scope }) });
    this.#config = Object.freeze({ ...config, native: Object.freeze({ ...config.native, scope: Object.freeze({ ...config.native.scope }),
      stripe: Object.freeze({ ...config.native.stripe }), producer: Object.freeze({ ...config.native.producer }) }),
      policy: Object.freeze({ quote: config.policy.quote.bind(config.policy), current: config.policy.current.bind(config.policy), currentForSend: config.policy.currentForSend.bind(config.policy) }),
      presentation: Object.freeze({ play: config.presentation.play.bind(config.presentation) }) });
  }
  #now() { return this.#config.native.clock?.() ?? new Date().toISOString(); }
  async #live(signal: AbortSignal): Promise<boolean> {
    const c = this.#call, state = await awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal), at = this.#now();
    return !!state?.ok && instant(at) && state.value.lifecycle === "active" && !!state.value.admission &&
      state.value.sessionLease?.sessionId === c.sessionId && Date.parse(state.value.sessionLease.expiresAt) > Date.parse(at) &&
      state.value.policy.policyVersion === c.policyVersion && state.value.policy.automationEnabled && state.value.policy.bookingEnabled &&
      state.value.policy.staffWorkEnabled === true && state.value.policy.capabilities.book === "execute" && !state.value.callerIdentityDenied &&
      !signal.aborted && !this.#lifetime.signal.aborted;
  }
  #current(p: Pending, signal: AbortSignal): boolean {
    const at = this.#now();
    return this.#pending === p && instant(at) && (!p.intent || p.intent.createdAt <= at) && (!p.consent || p.consent.acceptedAt <= at) && Date.parse(p.selection.expiresAt) > Date.parse(at) && Date.parse(p.assessment.expiresAt) > Date.parse(at) &&
      !signal.aborted && !this.#lifetime.signal.aborted && this.#config.policy.currentForSend(p.selection, p.assessment, signal) === true;
  }
  async #permit(p: Pending, signal: AbortSignal): Promise<boolean> {
    return await this.#live(signal) && await awaitUntilAbort(Promise.resolve().then(() => this.#config.policy.current(p.selection, p.assessment, signal)), signal) === true && this.#current(p, signal);
  }
  async prepare(prepared: PreparedClinikoBooking, external: AbortSignal): Promise<Readonly<{ kind: "ready" | "pending"; marker: string }> | undefined> {
    if (this.#busy || this.#lifetime.signal.aborted) return undefined;
    this.#busy = true; const signal = AbortSignal.any([external, this.#lifetime.signal]);
    try {
      const c = this.#call, e = prepared.evidence, r = prepared.request, selected = this.#records.selection();
      if (!sameScope(r.patient.scope, c.scope) || e.callId !== c.callId || e.sessionId !== c.sessionId ||
          selected.credentialFingerprint !== e.credentialFingerprint || selected.businessId !== e.businessId || !await this.#live(signal)) return undefined;
      const state = await awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal); if (!state?.ok || !state.value.sessionLease) return undefined;
      const selection = freeze({ scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
        verificationRef: r.patient.verificationRef, offerRef: r.offer.offerRef, patientId: r.patient.patientRef,
        businessId: e.businessId, practitionerId: e.practitionerId, appointmentTypeId: e.appointmentTypeId, credentialFingerprint: e.credentialFingerprint,
        startsAt: r.offer.startsAt, endsAt: e.endsAt, timeZone: e.timeZone, clinicalDigest: digestActionRequest(r),
        expiresAt: new Date(Math.min(Date.parse(r.offer.expiresAt), Date.parse(r.patient.expiresAt), Date.parse(state.value.sessionLease.expiresAt))).toISOString() });
      const prior = this.#pending;
      if (prior && JSON.stringify(prior.selection) === JSON.stringify(selection)) {
        if (!await this.#permit(prior, signal) || prior.phase === "declined") return undefined;
        return { kind: prior.phase === "accepted" || prior.phase === "notRequired" ? "ready" : "pending", marker: prior.marker };
      }
      this.invalidate();
      const raw = await awaitUntilAbort(Promise.resolve().then(() => this.#config.policy.quote(selection, signal)), signal);
      if (!raw || signal.aborted || !await this.#live(signal)) return undefined;
      const assessment = freeze(structuredClone(raw));
      if (!instant(assessment.expiresAt) || assessment.expiresAt > selection.expiresAt || assessment.expiresAt <= this.#now()) return undefined;
      if (assessment.kind === "notRequired") {
        if (typeof assessment.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(assessment.version)) return undefined;
        const pending: Pending = { fence: Object.freeze({}), selection, assessment, marker: randomUUID(), phase: "notRequired" }; this.#pending = pending;
        return await this.#permit(pending, signal) ? { kind: "ready", marker: pending.marker } : undefined;
      }
      if (assessment.kind !== "required" || typeof assessment.approvedTerms !== "string" || !assessment.approvedTerms.trim() || assessment.approvedTerms.length > 350 ||
          /[\u0000-\u001f\u007f]/.test(assessment.approvedTerms) || !["gbp", "aud", "nzd", "usd", "eur", "cad"].includes(assessment.payment.currency)) return undefined;
      const now = this.#now(), marker = randomUUID();
      const intent: ClinikoFinancialIntent = freeze({ actionRef: randomUUID(), scope: { ...c.scope }, patientId: selection.patientId,
        businessId: selection.businessId, credentialFingerprint: selection.credentialFingerprint,
        booking: { kind: "book", actionRef: marker, practitionerId: selection.practitionerId, appointmentTypeId: selection.appointmentTypeId, startsAt: selection.startsAt, endsAt: selection.endsAt },
        stripe: { ...selected.stripe }, payment: assessment.payment, recipient: assessment.recipient, createdAt: now,
        effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } });
      if (!encodeClinikoFinancialIntent(intent).ok) return undefined;
      const segments = financialReadback(intent, assessment, selection.timeZone); if (!segments) return undefined;
      const pending: Pending = { fence: Object.freeze({}), selection, assessment, marker, intent, readback: { segments, receipts: [] }, phase: "unplayed" }; this.#pending = pending;
      if (!await this.#permit(pending, signal)) return undefined;
      const retained = await awaitUntilAbort(this.#records.retainIntentOnce(intent, assessment.reviewDate, signal), signal);
      if (!retained?.ok || retained.value.kind !== "accepted" || !await this.#permit(pending, signal)) { this.#pending = undefined; return undefined; }
      pending.recallRef = retained.value.recallRef;
      return { kind: "pending", marker };
    } catch { this.#pending = undefined; return undefined; }
    finally { this.#busy = false; }
  }
  get inputActive(): boolean { return !!this.#pending && ["unplayed", "playing", "awaiting"].includes(this.#pending.phase) && !this.#lifetime.signal.aborted; }
  get readySelection(): Readonly<{ verificationRef: string; offerRef: string }> | undefined {
    const p = this.#pending; return p?.phase === "accepted" && this.#current(p, this.#lifetime.signal) ? { verificationRef: p.selection.verificationRef, offerRef: p.selection.offerRef } : undefined;
  }
  inputAdmission(): Readonly<{ fence: object; phase: "unplayed" | "awaiting" }> | undefined {
    const p = this.#pending; return p && (p.phase === "unplayed" || p.phase === "awaiting") ? { fence: p.fence, phase: p.phase } : undefined;
  }
  async acceptDigit(digit: string, admission: ReturnType<ClinikoFinancialBookingPreparation["inputAdmission"]>): Promise<"pending" | "verified"> {
    const p = this.#pending;
    if (!p || this.#busy || !admission || admission.fence !== p.fence || admission.phase !== p.phase || !this.inputActive) return "pending";
    this.#busy = true; const signal = AbortSignal.any([this.#lifetime.signal, this.#quoteLifetime.signal, AbortSignal.timeout(25_000)]);
    try {
      if (!await this.#permit(p, signal) || p.assessment.kind !== "required" || !p.intent) return "pending";
      if (digit === "2" || digit === "*") { delete p.consent; p.phase = "declined"; return "verified"; }
      if (p.phase === "unplayed") {
        if (digit !== "1" || !p.readback) return "pending";
        p.phase = "playing";
        const text = p.readback.segments[p.readback.receipts.length]; if (!text) { p.phase = "declined"; return "verified"; }
        const receipt = await awaitUntilAbort(this.#config.presentation.play(text, signal, () => { try { return this.#current(p, signal); } catch { return false; } }), signal);
        const previous = p.readback.receipts.at(-1);
        if (!receipt || !instant(receipt.playedAt) || receipt.playedAt < (previous?.playedAt ?? p.intent.createdAt) || receipt.playedAt > this.#now() || !validRecallMarker(receipt.presentationRef) ||
            p.readback.receipts.some(r => r.presentationRef === receipt.presentationRef) || !await this.#permit(p, signal)) { p.phase = "declined"; return "verified"; }
        p.readback.receipts.push(Object.freeze({ ...receipt })); p.fence = Object.freeze({});
        if (p.readback.receipts.length < p.readback.segments.length) { p.phase = "unplayed"; return "pending"; }
        p.consent = freeze({ presentationRef: receipt.presentationRef, presentationDigest: createHash("sha256").update(JSON.stringify(p.readback.segments)).digest("hex"), playedAt: receipt.playedAt, acceptedAt: receipt.playedAt, acceptanceRef: randomUUID() });
        p.phase = "awaiting"; return "pending";
      }
      if (p.phase !== "awaiting") return "pending";
      if (digit !== "1" || !p.consent || this.#now() < p.consent.playedAt) return "pending";
      p.consent = freeze({ ...p.consent, acceptedAt: this.#now(), acceptanceRef: randomUUID() }); p.phase = "accepted";
      return "verified";
    } catch { p.phase = "declined"; return "verified"; }
    finally { this.#busy = false; }
  }
  async beforeSend(external: AbortSignal): Promise<boolean> { const p = this.#pending; return !!p && ["accepted", "notRequired"].includes(p.phase) && this.#permit(p, AbortSignal.any([external, this.#lifetime.signal])); }
  currentForSend(signal: AbortSignal): boolean { const p = this.#pending; try { return !!p && ["accepted", "notRequired"].includes(p.phase) && this.#current(p, signal); } catch { return false; } }
  async capture(signal: AbortSignal): Promise<FinancialBookingCapture | undefined> {
    const p = this.#pending; if (!p || !await this.beforeSend(signal)) return undefined;
    if (p.phase === "notRequired") return { kind: "notRequired" };
    if (!p.intent || !p.recallRef || !p.consent || p.assessment.kind !== "required") return undefined;
    const capture = await ClinikoFinancialBookingCapture.prepare({ reader: this.#reader, privateKey: this.#config.privateKey,
      producerKeyRef: this.#config.native.producer.keyRef, clock: () => this.#now(), financialConsent: p.consent },
      { recallRef: p.recallRef, actionRef: p.intent.actionRef }, p.intent, signal);
    return capture.ok ? { kind: "required", capture: capture.value, intent: p.intent, recallRef: p.recallRef, reviewDate: p.assessment.reviewDate } : undefined;
  }
  async retain(captured: Extract<FinancialBookingCapture, { kind: "required" }>, notes: string): Promise<void> {
    try { await this.#records.retainBookingObservationOnce(notes, { intent: captured.intent, intentRecallRef: captured.recallRef }, captured.reviewDate, this.#config.financialSignal); }
    catch { /* Provider-owned pending intent remains for independent review. */ }
  }
  invalidate(): void { this.#quoteLifetime.abort(); this.#quoteLifetime = new AbortController(); this.#pending = undefined; }
  dispose(): void { this.#lifetime.abort(); this.invalidate(); }
}
