import { validAdmission, sameCallAdmission } from "./call-admission.ts";
import { POSSIBLE_SEND_RECOVERY_DELAY_MS, err, ok } from "./model.ts";
import type { ActiveSessionReceipt, Admission, AdmissionReceipt, AdmissionResult, ApprovedGreeting, CallPolicy, CallState, LocationScope, PendingLocationCall, PendingLocationExpiryResult, PendingLocationPrompt, PendingLocationResult, PendingLocationRoute, PendingPresentationRef, RecoverableEffectRef, Result, StaffQueueEntry, TransitionAction, TransitionFailure } from "./model.ts";
import { transition } from "./transition.ts";
import { validApprovedGreeting } from "./greeting.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "./readiness.ts";
import { LOCATION_CHOICE_TIMEOUT_MS, PENDING_LOCATION_LEASE_MS, closePendingLocationState, expiredPendingLocationState, pendingDueAt, pendingMatchesAdmission, policyMatchesPending, resolveLocationPrompt, startLocationPrompt, validPendingAdmission, validPendingRoute } from "./pending-location.ts";
import type { AutomationReadiness } from "./readiness.ts";
import type { EffectCallLeaseGuard, EffectCallLeaseStore } from "./effect-call-lease.ts";
import type { InFlightWrite, WriteStopAuditEntry, WriteStopAuditPage, WriteStopFailure, WriteStopStatus } from "./write-stop.ts";

export interface LedgerStore {
  stopWrites(scope: LocationScope, actorRef: string, reason: string): Promise<Result<WriteStopStatus, TransitionFailure>>;
  readWriteStop(scope: LocationScope, afterEffectId?: string): Promise<Result<WriteStopStatus, TransitionFailure>>;
  resumeWrites(scope: LocationScope, expectedVersion: string, actorRef: string, reason: string): Promise<Result<WriteStopStatus, WriteStopFailure>>;
  listWriteStopChanges(scope: LocationScope, afterVersion?: number): Promise<Result<WriteStopAuditPage, TransitionFailure>>;
  start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>>;
  findAdmission(callId: string): Promise<Result<AdmissionReceipt | null, TransitionFailure>>;
  findPendingLocation(callId: string): Promise<Result<PendingLocationCall | null, TransitionFailure>>;
  reservePendingLocation(callId: string, route: PendingLocationRoute, admission: Admission): Promise<Result<PendingLocationResult, TransitionFailure>>;
  attachPendingLocationSession(callId: string, sessionId: string, now: string): Promise<Result<PendingLocationCall, TransitionFailure>>;
  renewPendingLocationSession(callId: string, sessionId: string, expectedVersion: number, now: string): Promise<Result<PendingLocationCall, TransitionFailure>>;
  startPendingLocationPrompt(callId: string, playbackId: string, sessionId: string, expectedVersion: number, now: string, afterPlayed?: boolean):
    Promise<Result<Readonly<{ pending: PendingLocationCall; newStart: boolean }>, TransitionFailure>>;
  resolvePendingLocationPrompt(callId: string, playbackId: string, sessionId: string, expectedVersion: number,
                               status: PendingLocationPrompt["status"], now: string): Promise<Result<PendingLocationCall, TransitionFailure>>;
  closePendingLocationSession(callId: string, sessionId: string, expectedVersion: number,
                              reason: NonNullable<PendingLocationCall["closeEvidence"]>["reason"], now: string):
    Promise<Result<PendingLocationCall, TransitionFailure>>;
  bindPendingLocation(callId: string, policy: CallPolicy, sessionId: string, expectedLeaseVersion: number, turnId: string, now: string): Promise<Result<AdmissionResult, TransitionFailure>>;
  findExpiredPendingLocations(now: string, clinic?: Pick<LocationScope, "tenantId" | "clinicId">): Promise<Result<readonly PendingLocationCall[], TransitionFailure>>;
  expirePendingLocation(callId: string, now: string): Promise<Result<PendingLocationExpiryResult, TransitionFailure>>;
  findExpiredAdmissions(now: string, scope?: LocationScope): Promise<Result<readonly AdmissionReceipt[], TransitionFailure>>;
  findExpiredSessions(now: string, scope?: LocationScope): Promise<Result<readonly ActiveSessionReceipt[], TransitionFailure>>;
  findPendingPresentations(now: string, scope?: LocationScope, afterCallId?: string): Promise<Result<readonly PendingPresentationRef[], TransitionFailure>>;
  findRecoverableEffects(now: string, scope?: LocationScope, afterEffectId?: string): Promise<Result<readonly RecoverableEffectRef[], TransitionFailure>>;
  admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>>;
  read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>>;
  listCalls(scope: LocationScope, afterCallId?: string): Promise<Result<readonly CallState[], TransitionFailure>>;
  listStaffItems(scope: LocationScope, afterTaskKey?: string): Promise<Result<readonly StaffQueueEntry[], TransitionFailure>>;
  apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction, guard?: EffectCallLeaseGuard): Promise<Result<CallState, TransitionFailure>>;
}

export function initialState(callId: string, policy: CallPolicy): CallState {
  return {
    callId,
    policy: structuredClone(policy),
    lifecycle: "active",
    version: 0,
    conversationRevision: 0,
    processedTurnIds: [],
    actions: {},
    presentations: {},
    effects: {},
    staffItems: {},
    callerMessages: [],
    knowledgeAnswers: [],
    availabilityReads: [],
    appointmentReads: [],
  };
}

/** One durable greeting intent is committed with a voice admission, before any media is sent. */
export function initialAdmittedState(callId: string, policy: CallPolicy & { greeting: ApprovedGreeting }, admission: Admission): CallState {
  const state = initialState(callId, policy);
  const presentationId = `${callId}:greeting`;
  state.lifecycle = "starting";
  state.admission = structuredClone(admission);
  state.presentations[presentationId] = { kind: "notice", id: presentationId,
    approvedText: policy.greeting.approvedText, status: "pending" };
  state.pendingPresentationId = presentationId;
  return state;
}

export function admissionReceipt(state: CallState): AdmissionReceipt | null {
  return state.admission ? { callId: state.callId, scope: structuredClone(state.policy.scope), admission: structuredClone(state.admission), lifecycle: state.lifecycle } : null;
}

export function sameAdmission(left: Admission, right: Admission): boolean {
  return sameCallAdmission(left, right);
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export class MemoryLedger implements LedgerStore, EffectCallLeaseStore {
  private readonly calls = new Map<string, CallState>();
  private readonly effectCallLeases = new Map<string, Readonly<{ owner: string | null; version: number; expiresAt: number }>>();
  private readonly pendingLocations = new Map<string, PendingLocationCall>();
  private readonly writeStops = new Map<string, Array<WriteStopAuditEntry & Readonly<{ inFlight: readonly InFlightWrite[] }>>>();
  private readonly readiness: AutomationReadiness;
  private readonly leaseClock: () => number;

  constructor(readiness: AutomationReadiness = unprovenReadiness, leaseClock: () => number = Date.now) {
    this.readiness = readiness;
    this.leaseClock = leaseClock;
  }

  /** Release a ledger owned by one disconnected live call. Do not reuse it afterward. */
  dispose(): void {
    this.calls.clear();
    this.effectCallLeases.clear();
    this.pendingLocations.clear();
    this.writeStops.clear();
  }

  private stopKey(scope: LocationScope): string {
    return JSON.stringify([scope.tenantId, scope.clinicId]);
  }

  async stopWrites(scope: LocationScope, actorRef: string, reason: string): Promise<Result<WriteStopStatus, TransitionFailure>> {
    if (!actorRef.trim() || actorRef.length > 256 || !reason.trim() || reason.length > 1_000) return err({ kind: "invalidTransition" });
    const key = this.stopKey(scope);
    const events = this.writeStops.get(key) ?? [];
    if (!events.at(-1)?.stopped) {
      const inFlight: InFlightWrite[] = [];
      for (const state of this.calls.values()) {
        if (this.stopKey(state.policy.scope) !== key) continue;
        for (const effect of Object.values(state.effects)) {
          if ((effect.kind === "hostWrite" || effect.kind === "notification") && (effect.status === "possiblySent" || effect.status === "uncertain")) {
            inFlight.push({ effectId: effect.id, callId: state.callId, actionKey: effect.actionKey, status: effect.status });
          }
        }
      }
      inFlight.sort((left, right) => left.effectId.localeCompare(right.effectId));
      events.push({ version: String(events.length + 1), stopped: true, actorRef, reason, changedAt: new Date().toISOString(), inFlight });
      this.writeStops.set(key, events);
    }
    return this.readWriteStop(scope);
  }

  async resumeWrites(scope: LocationScope, expectedVersion: string, actorRef: string, reason: string): Promise<Result<WriteStopStatus, WriteStopFailure>> {
    if (!actorRef.trim() || actorRef.length > 256 || !reason.trim() || reason.length > 1_000) return err({ kind: "invalidTransition" });
    const key = this.stopKey(scope);
    const current = this.writeStops.get(key)?.at(-1);
    if (String(current?.version ?? 0) !== expectedVersion) return err({ kind: "versionConflict" });
    if (!current?.stopped) return err({ kind: "invalidTransition" });
    try {
      const ready = await this.readiness(scope);
      if (!ready.ok) return ready;
      if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
    } catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
    const events = this.writeStops.get(key)!;
    if (events.at(-1)?.version !== current.version) return err({ kind: "versionConflict" });
    events.push({ version: String(events.length + 1), stopped: false, actorRef, reason, changedAt: new Date().toISOString(), inFlight: [] });
    return this.readWriteStop(scope);
  }

  async readWriteStop(scope: LocationScope, afterEffectId?: string): Promise<Result<WriteStopStatus, TransitionFailure>> {
    if (afterEffectId !== undefined && (!afterEffectId || afterEffectId.length > 512)) return err({ kind: "invalidTransition" });
    const stop = this.writeStops.get(this.stopKey(scope))?.at(-1);
    if (!stop) return ok({ stopped: false, version: "0", inFlight: [] });
    const inFlight = stop.stopped ? stop.inFlight.filter(item => !afterEffectId || item.effectId > afterEffectId).slice(0, 50) : [];
    return ok({ stopped: stop.stopped, version: stop.version, actorRef: stop.actorRef, reason: stop.reason, changedAt: stop.changedAt,
      inFlight: structuredClone(inFlight), ...(inFlight.length === 50 ? { nextAfterEffectId: inFlight[49]!.effectId } : {}) });
  }

  async listWriteStopChanges(scope: LocationScope, afterVersion?: number): Promise<Result<WriteStopAuditPage, TransitionFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidTransition" });
    const entries = (this.writeStops.get(this.stopKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50)
      .map(({ inFlight: _inFlight, ...entry }) => entry);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>> {
    if (!callId || this.calls.has(callId) || this.pendingLocations.has(callId)) return err({ kind: "invalidTransition" });
    const state = initialState(callId, policy);
    this.calls.set(callId, state);
    return ok(structuredClone(state));
  }

  async findAdmission(callId: string): Promise<Result<AdmissionReceipt | null, TransitionFailure>> {
    return ok(this.calls.has(callId) ? admissionReceipt(this.calls.get(callId)!) : null);
  }

  async findPendingLocation(callId: string): Promise<Result<PendingLocationCall | null, TransitionFailure>> {
    return ok(structuredClone(this.pendingLocations.get(callId) ?? null));
  }

  async reservePendingLocation(callId: string, route: PendingLocationRoute, admission: Admission): Promise<Result<PendingLocationResult, TransitionFailure>> {
    if (!validPendingRoute(route) || !validPendingAdmission(callId, admission)) return err({ kind: "invalidTransition" });
    if (this.calls.has(callId)) return err({ kind: "callConflict" });
    const existing = this.pendingLocations.get(callId);
    if (existing) return pendingMatchesAdmission(existing, admission)
      ? ok({ kind: "duplicate", pending: structuredClone(existing) }) : err({ kind: "callConflict" });
    const acceptedAt = admission.acceptedAt;
    const pending: PendingLocationCall = { callId, route: structuredClone(route),
      admission: { ...structuredClone(admission), deadline: new Date(Date.parse(acceptedAt) + LOCATION_CHOICE_TIMEOUT_MS).toISOString() },
      status: "pending" };
    this.pendingLocations.set(callId, pending);
    return ok({ kind: "created", pending: structuredClone(pending) });
  }

  async attachPendingLocationSession(callId: string, sessionId: string, now: string): Promise<Result<PendingLocationCall, TransitionFailure>> {
    if (!sessionId?.trim() || sessionId.length > 256 || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    if (pending.status === "expired") return err({ kind: "admissionExpired" });
    if (pending.status !== "pending") return err({ kind: "callConflict" });
    if (Date.parse(now) >= Date.parse(pending.admission.deadline)) return err({ kind: "admissionExpired" });
    const lease = pending.sessionLease;
    if (lease) {
      if (lease.sessionId !== sessionId || Date.parse(now) >= Date.parse(lease.expiresAt)) return err({ kind: "leaseLost" });
      return ok(structuredClone({ ...pending, sessionLease: { ...lease, validForMs: Date.parse(lease.expiresAt) - Date.parse(now) } }));
    }
    const validForMs = Math.min(PENDING_LOCATION_LEASE_MS, Date.parse(pending.admission.deadline) - Date.parse(now));
    const attached: PendingLocationCall = { ...pending, sessionLease: { sessionId, version: 1,
      expiresAt: new Date(Date.parse(now) + validForMs).toISOString(), validForMs } };
    this.pendingLocations.set(callId, attached);
    return ok(structuredClone(attached));
  }

  async renewPendingLocationSession(callId: string, sessionId: string, expectedVersion: number, now: string): Promise<Result<PendingLocationCall, TransitionFailure>> {
    if (!sessionId?.trim() || !Number.isSafeInteger(expectedVersion) || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    const lease = pending.sessionLease;
    if (pending.status !== "pending" || !lease || lease.sessionId !== sessionId ||
        Date.parse(now) >= pendingDueAt(pending)) return err({ kind: "leaseLost" });
    if (lease.version > 1 && expectedVersion === lease.version - 1) {
      return ok(structuredClone({ ...pending, sessionLease: { ...lease, validForMs: Date.parse(lease.expiresAt) - Date.parse(now) } }));
    }
    if (lease.version !== expectedVersion) return err({ kind: "leaseLost" });
    const validForMs = Math.min(PENDING_LOCATION_LEASE_MS, Date.parse(pending.admission.deadline) - Date.parse(now));
    const renewed: PendingLocationCall = { ...pending, sessionLease: { sessionId, version: lease.version + 1,
      expiresAt: new Date(Date.parse(now) + validForMs).toISOString(), validForMs } };
    this.pendingLocations.set(callId, renewed);
    return ok(structuredClone(renewed));
  }

  async startPendingLocationPrompt(callId: string, playbackId: string, sessionId: string, expectedVersion: number, now: string, afterPlayed = false):
    Promise<Result<Readonly<{ pending: PendingLocationCall; newStart: boolean }>, TransitionFailure>> {
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    const started = startLocationPrompt(pending, playbackId, sessionId, expectedVersion, now, afterPlayed);
    if (!started.ok) return started;
    if (started.value.newStart) this.pendingLocations.set(callId, started.value.pending);
    return ok(structuredClone(started.value));
  }

  async resolvePendingLocationPrompt(callId: string, playbackId: string, sessionId: string, expectedVersion: number,
                                     status: PendingLocationPrompt["status"], now: string): Promise<Result<PendingLocationCall, TransitionFailure>> {
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    const resolved = resolveLocationPrompt(pending, playbackId, sessionId, expectedVersion, status, now);
    if (!resolved.ok) return resolved;
    this.pendingLocations.set(callId, resolved.value);
    return ok(structuredClone(resolved.value));
  }

  async closePendingLocationSession(callId: string, sessionId: string, expectedVersion: number,
                                    reason: NonNullable<PendingLocationCall["closeEvidence"]>["reason"], now: string):
    Promise<Result<PendingLocationCall, TransitionFailure>> {
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    const closed = closePendingLocationState(pending, sessionId, expectedVersion, reason, now);
    if (!closed.ok) return closed;
    this.pendingLocations.set(callId, closed.value);
    return ok(structuredClone(closed.value));
  }

  async bindPendingLocation(callId: string, policy: CallPolicy, sessionId: string, expectedLeaseVersion: number, turnId: string, now: string): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (!sessionId?.trim() || sessionId.length > 256 || !turnId?.trim() || turnId.length > 256 ||
        !Number.isSafeInteger(expectedLeaseVersion) || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    const existing = this.calls.get(callId);
    if (pending.status === "bound" && existing) return policyMatchesPending(pending, policy) &&
      sameScope(existing.policy.scope, policy.scope) && pending.choiceEvidence?.sessionId === sessionId &&
      pending.choiceEvidence.leaseVersion === expectedLeaseVersion && pending.choiceEvidence.turnId === turnId
      ? ok({ kind: "duplicate", receipt: admissionReceipt(existing)! }) : err({ kind: "scopeMismatch" });
    if (pending.status !== "pending" || existing) return err({ kind: "callConflict" });
    if (Date.parse(now) >= pendingDueAt(pending)) {
      this.pendingLocations.set(callId, expiredPendingLocationState(pending, now));
      return err({ kind: "admissionExpired" });
    }
    if (!pending.sessionLease || pending.sessionLease.sessionId !== sessionId ||
        pending.sessionLease.version !== expectedLeaseVersion) return err({ kind: "leaseLost" });
    if (!policyMatchesPending(pending, policy)) return err({ kind: "scopeMismatch" });
    const admission: Admission = { ...pending.admission, acceptedAt: now,
      deadline: new Date(Date.parse(now) + 30_000).toISOString() };
    if (!validApprovedGreeting(policy)) return err({ kind: "invalidTransition" });
    const state = initialAdmittedState(callId, policy, admission);
    this.calls.set(callId, state);
    this.pendingLocations.set(callId, { ...pending, status: "bound", choiceEvidence: { sessionId, leaseVersion: expectedLeaseVersion, turnId,
      selectedLocationId: policy.scope.locationId, at: now } });
    return ok({ kind: "created", receipt: admissionReceipt(state)! });
  }

  async findExpiredPendingLocations(now: string, clinic?: Pick<LocationScope, "tenantId" | "clinicId">): Promise<Result<readonly PendingLocationCall[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    return ok([...this.pendingLocations.values()].filter(pending => pending.status === "pending" &&
      pendingDueAt(pending) <= Date.parse(now) &&
      (!clinic || (pending.route.tenantId === clinic.tenantId && pending.route.clinicId === clinic.clinicId)))
      .sort((left, right) => left.callId.localeCompare(right.callId)).slice(0, 100).map(pending => structuredClone(pending)));
  }

  async expirePendingLocation(callId: string, now: string): Promise<Result<PendingLocationExpiryResult, TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const pending = this.pendingLocations.get(callId);
    if (!pending) return err({ kind: "callUnknown" });
    if (pending.status === "bound") return this.calls.has(callId)
      ? ok({ kind: "bound", pending: structuredClone(pending) }) : err({ kind: "storageCorrupt" });
    if (pending.status === "expired") return ok({ kind: "alreadyExpired", pending: structuredClone(pending) });
    if (Date.parse(now) < pendingDueAt(pending)) return err({ kind: "invalidTransition" });
    const expired = expiredPendingLocationState(pending, now);
    this.pendingLocations.set(callId, expired);
    return ok({ kind: "expired", pending: structuredClone(expired) });
  }

  async findExpiredAdmissions(now: string, scope?: LocationScope): Promise<Result<readonly AdmissionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    return ok([...this.calls.values()].filter(state => (!scope || sameScope(state.policy.scope, scope)) && state.lifecycle === "starting" && state.admission && Date.parse(state.admission.deadline) <= Date.parse(now))
      .slice(0, 100).map(state => admissionReceipt(state)!));
  }

  async findExpiredSessions(now: string, scope?: LocationScope): Promise<Result<readonly ActiveSessionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    return ok([...this.calls.values()].filter(state => (!scope || sameScope(state.policy.scope, scope)) && state.lifecycle === "active" && state.sessionLease && Date.parse(state.sessionLease.expiresAt) <= Date.parse(now))
      .slice(0, 100).map(state => ({ callId: state.callId, scope: structuredClone(state.policy.scope), lease: structuredClone(state.sessionLease!) })));
  }

  async findPendingPresentations(now: string, scope?: LocationScope, afterCallId?: string): Promise<Result<readonly PendingPresentationRef[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const refs = [...this.calls.values()]
      .filter(state => (!scope || sameScope(state.policy.scope, scope)) && (!afterCallId || state.callId > afterCallId) &&
        state.lifecycle === "active" && state.admission && state.sessionLease && Date.parse(state.sessionLease.expiresAt) > Date.parse(now) && state.pendingPresentationId)
      .sort((left, right) => left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0).slice(0, 100);
    return ok(refs.map(state => ({ callId: state.callId, scope: structuredClone(state.policy.scope), sessionId: state.sessionLease!.sessionId,
      presentationId: state.pendingPresentationId! })));
  }

  async findRecoverableEffects(now: string, scope?: LocationScope, afterEffectId?: string): Promise<Result<readonly RecoverableEffectRef[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now)) || (afterEffectId !== undefined && (!afterEffectId || afterEffectId.length > 512))) return err({ kind: "invalidTransition" });
    const refs: RecoverableEffectRef[] = [];
    for (const state of this.calls.values()) {
      if (scope && !sameScope(state.policy.scope, scope)) continue;
      for (const effect of Object.values(state.effects)) {
        if (afterEffectId && effect.id <= afterEffectId) continue;
        if (effect.status !== "pending" && (effect.status !== "possiblySent" || !effect.possiblySentAt ||
            Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS > Date.parse(now))) continue;
        refs.push({ callId: state.callId, scope: structuredClone(state.policy.scope), effectId: effect.id,
          kind: effect.kind, status: effect.status });
      }
    }
    return ok(refs.sort((left, right) => left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0).slice(0, 100));
  }

  async claimEffectCall(callId: string, scope: LocationScope, owner: string, leaseMs: number, now: string): Promise<Result<Readonly<{ version: number }> | null, TransitionFailure>> {
    const state = this.calls.get(callId);
    if (!state) return err({ kind: "callUnknown" });
    if (!sameScope(state.policy.scope, scope)) return err({ kind: "scopeMismatch" });
    const time = Date.parse(now);
    if (!owner || owner.length > 256 || !Number.isFinite(time) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
      return err({ kind: "invalidTransition" });
    }
    const existing = this.effectCallLeases.get(callId);
    if (existing && existing.owner !== null && existing.expiresAt > time) return ok(null);
    const version = (existing?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version)) return err({ kind: "storageCorrupt" });
    this.effectCallLeases.set(callId, { owner, version, expiresAt: time + leaseMs });
    return ok({ version });
  }

  async renewEffectCall(callId: string, scope: LocationScope, guard: EffectCallLeaseGuard, leaseMs: number, now: string): Promise<Result<boolean, TransitionFailure>> {
    const state = this.calls.get(callId);
    if (!state) return err({ kind: "callUnknown" });
    if (!sameScope(state.policy.scope, scope)) return err({ kind: "scopeMismatch" });
    const time = Date.parse(now);
    if (!guard.owner || guard.owner.length > 256 || !Number.isSafeInteger(guard.version) || guard.version < 1 ||
        !Number.isFinite(time) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
      return err({ kind: "invalidTransition" });
    }
    const existing = this.effectCallLeases.get(callId);
    if (!existing || existing.owner !== guard.owner || existing.version !== guard.version || existing.expiresAt <= time) return ok(false);
    this.effectCallLeases.set(callId, { ...existing, expiresAt: time + leaseMs });
    return ok(true);
  }

  async releaseEffectCall(callId: string, scope: LocationScope, guard: EffectCallLeaseGuard): Promise<Result<boolean, TransitionFailure>> {
    const state = this.calls.get(callId);
    if (!state) return err({ kind: "callUnknown" });
    if (!sameScope(state.policy.scope, scope)) return err({ kind: "scopeMismatch" });
    if (!guard.owner || guard.owner.length > 256 || !Number.isSafeInteger(guard.version) || guard.version < 1) return err({ kind: "invalidTransition" });
    const existing = this.effectCallLeases.get(callId);
    if (!existing || existing.owner !== guard.owner || existing.version !== guard.version) return ok(false);
    this.effectCallLeases.set(callId, { ...existing, owner: null });
    return ok(true);
  }

  async admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (!callId || !validAdmission(admission)) return err({ kind: "invalidTransition" });
    const existing = this.calls.get(callId);
    if (existing) {
      const receipt = admissionReceipt(existing);
      return receipt && sameAdmission(receipt.admission, admission)
        ? ok({ kind: "duplicate", receipt }) : err({ kind: "callConflict" });
    }
    if (this.pendingLocations.has(callId)) return err({ kind: "callConflict" });
    if (!validApprovedGreeting(policy)) return err({ kind: "invalidTransition" });
    const state = initialAdmittedState(callId, policy, admission);
    this.calls.set(callId, state);
    return ok({ kind: "created", receipt: admissionReceipt(state)! });
  }

  async read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>> {
    const state = this.calls.get(callId);
    return state && sameScope(state.policy.scope, scope) ? ok(structuredClone(state)) : err({ kind: "callUnknown" });
  }

  async listCalls(scope: LocationScope, afterCallId?: string): Promise<Result<readonly CallState[], TransitionFailure>> {
    if (afterCallId !== undefined && (!afterCallId || afterCallId.length > 256)) return err({ kind: "invalidTransition" });
    return ok([...this.calls.values()]
      .filter(state => sameScope(state.policy.scope, scope) && (!afterCallId || state.callId > afterCallId))
      .sort((left, right) => left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0)
      .slice(0, 100).map(state => structuredClone(state)));
  }

  async listStaffItems(scope: LocationScope, afterTaskKey?: string): Promise<Result<readonly StaffQueueEntry[], TransitionFailure>> {
    if (afterTaskKey !== undefined && (!afterTaskKey || afterTaskKey.length > 256)) return err({ kind: "invalidTransition" });
    const entries: StaffQueueEntry[] = [];
    for (const state of this.calls.values()) {
      if (!sameScope(state.policy.scope, scope)) continue;
      for (const item of Object.values(state.staffItems)) {
        if (afterTaskKey && item.key <= afterTaskKey) continue;
        entries.push({ callId: state.callId, callVersion: state.version, taskKey: item.key, reason: item.reason, status: item.status, dueAt: item.dueAt,
          destination: structuredClone(item.destination), ...(item.linkedActionKey === undefined ? {} : { linkedActionKey: item.linkedActionKey }),
          ...(item.pendingChangeKey === undefined ? {} : { pendingChangeKey: item.pendingChangeKey }),
          ...(item.reviewRequired === undefined ? {} : { reviewRequired: item.reviewRequired }),
          ...(item.alerts === undefined ? {} : { alerts: structuredClone(item.alerts) }) });
      }
    }
    return ok(entries.sort((left, right) => left.taskKey.localeCompare(right.taskKey)).slice(0, 50));
  }

  async apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction, guard?: EffectCallLeaseGuard): Promise<Result<CallState, TransitionFailure>> {
    const current = this.calls.get(callId);
    if (!current || !sameScope(current.policy.scope, scope)) return err({ kind: "callUnknown" });
    if (guard) {
      const lease = this.effectCallLeases.get(callId);
      let leaseNow: number;
      try { leaseNow = this.leaseClock(); }
      catch { return err({ kind: "storageFailure" }); }
      if (!Number.isFinite(leaseNow)) return err({ kind: "storageFailure" });
      if (!lease || lease.owner !== guard.owner || lease.version !== guard.version || lease.expiresAt <= leaseNow) {
        return err({ kind: "leaseLost" });
      }
    }
    if (current.version !== expectedVersion) return err({ kind: "versionConflict" });
    const stopped = this.writeStops.get(this.stopKey(scope))?.at(-1)?.stopped;
    const effectiveAction = action.kind === "markHostPossiblySent" && stopped
      ? { kind: "hostWriteBlocked" as const, effectId: action.effectId, now: action.now }
      : action.kind === "markNotificationPossiblySent" && stopped
        ? { kind: "notificationBlocked" as const, effectId: action.effectId, reason: "emergencyStop" as const, now: action.now } : action;
    const result = transition(current, effectiveAction);
    if (!result.ok) return result;
    this.calls.set(callId, structuredClone(result.value));
    return ok(structuredClone(result.value));
  }
}
