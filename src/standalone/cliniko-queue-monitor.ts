import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type Database from "../storage/generated/Database.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { OwnerFileStaffPolicy } from "./owner-file-staff-policy.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import { clinicQueueDate, collectClinikoRecallQueuePulse } from "./cliniko-queue-pulse.ts";
import { operationalAlertKey, validAlertScope } from "./operational-alert.ts";
import type { AggregateAlertKind } from "./operational-alert.ts";

export type QueueMonitorApproval = ClinicApproval & Readonly<{ policyVersion: string; businessId: string; recallTypeId: string;
  credentialFingerprint: string; timeZone: string; reviewOwnerRef: string; reviewBackupRef: string;
  pollEveryMinutes: number; pendingThreshold: number; overdueThreshold: number;
  alertUnavailable: true; destinationFingerprint: string; alertTokenFingerprint: string }>;
export type ClinikoQueueMonitorConfig = Readonly<{ db: Kysely<Database>; scope: LocationScope;
  apiKey: string; contactEmail: string; businessId: string; recallTypeId: string; timeZone: string; policyVersion: string;
  staffApprovalPath: string; monitorApprovalPath: string; directory: AdminDirectory;
  destination: string; alertTokenHex: string; pollEveryMinutes: number; sharedBudgetUserRef?: string;
  clinikoFetch?: typeof fetch; alertFetch?: typeof fetch; clock?: () => string; allowTestLoopbackHttp?: boolean }>;
export type QueueMonitorResult = Readonly<{ status: "queueKnown" | "queueUnavailable" | "approvalUnavailable" | "deliveryUnavailable" | "monitorBusy";
  accepted: number; attempted: number; pending?: number; overdue?: number }>;
const unavailable = () => new Error("Cliniko queue monitoring unavailable");
export const queueMonitorFingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export function queueMonitorDestination(raw: string, allowTestLoopbackHttp = false): string {
  const url = new URL(raw), local = allowTestLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || raw !== url.toString()) throw unavailable();
  return url.toString();
}
function decode(value: unknown, scope: LocationScope): QueueMonitorApproval | undefined {
  const extra = ["policyVersion", "businessId", "recallTypeId", "credentialFingerprint", "timeZone", "reviewOwnerRef", "reviewBackupRef",
    "pollEveryMinutes", "pendingThreshold", "overdueThreshold", "alertUnavailable", "destinationFingerprint", "alertTokenFingerprint"];
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, ...extra])) return undefined;
  const row = value as Record<string, unknown>;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !validClinikoId(row.recallTypeId) ||
      !approvalRef(row.reviewOwnerRef) || !approvalRef(row.reviewBackupRef) || row.reviewOwnerRef === row.reviewBackupRef ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.alertUnavailable !== true ||
      [row.credentialFingerprint, row.destinationFingerprint, row.alertTokenFingerprint].some(v => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) ||
      !Number.isSafeInteger(row.pollEveryMinutes) || Number(row.pollEveryMinutes) < 1 || Number(row.pollEveryMinutes) > 1440 ||
      [row.pendingThreshold, row.overdueThreshold].some(v => !Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 500)) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: row.timeZone }); } catch { return undefined; }
  return row as unknown as QueueMonitorApproval;
}

/** Independent aggregate monitoring, not a caller action or staff acknowledgment.
 * Each run rereads approved full-type queue health under the shared provider
 * budget, rechecks current duty/backup/receiver authority and submits no PHI.
 * A failed scan cannot become a healthy zero; one run never retries a POST. */
export class ClinikoQueueMonitor {
  readonly #config: ClinikoQueueMonitorConfig;
  readonly #staff: OwnerFileStaffPolicy;
  readonly #approval: OwnerFileClinicApproval<QueueMonitorApproval>;
  #busy = false;
  private constructor(config: ClinikoQueueMonitorConfig, staff: OwnerFileStaffPolicy, approval: OwnerFileClinicApproval<QueueMonitorApproval>) {
    this.#config = config; this.#staff = staff; this.#approval = approval;
  }
  static async create(incoming: ClinikoQueueMonitorConfig) {
    try {
      if (!incoming || !validAlertScope(incoming.scope) || !approvalRef(incoming.policyVersion) || !validClinikoId(incoming.businessId) || !validClinikoId(incoming.recallTypeId) ||
          typeof incoming.alertTokenHex !== "string" || !/^[a-f0-9]{64}$/i.test(incoming.alertTokenHex) ||
          !Number.isSafeInteger(incoming.pollEveryMinutes) || incoming.pollEveryMinutes < 1 || incoming.pollEveryMinutes > 1440 ||
          typeof incoming.db?.transaction !== "function" || typeof incoming.directory?.findByRef !== "function" ||
          (incoming.clock !== undefined && typeof incoming.clock !== "function")) throw unavailable();
      const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }),
        destination: queueMonitorDestination(incoming.destination, incoming.allowTestLoopbackHttp === true) });
      const staff = await OwnerFileStaffPolicy.capture({ path: config.staffApprovalPath, scope: config.scope, directory: config.directory,
        policyVersion: config.policyVersion, businessId: config.businessId, recallTypeId: config.recallTypeId, timeZone: config.timeZone,
        credentialFingerprint: clinikoCredentialFingerprint(config.apiKey), ...(config.clock ? { clock: config.clock } : {}) });
      const approval = await OwnerFileClinicApproval.capture({ path: config.monitorApprovalPath, scope: config.scope, directory: config.directory,
        decode, ...(config.clock ? { clock: config.clock } : {}) });
      if (!staff.ok || !approval.ok) throw unavailable();
      const monitor = new ClinikoQueueMonitor(config, staff.value, approval.value);
      if (!await monitor.#current(new AbortController().signal)) throw unavailable(); return ok(monitor);
    } catch { return err({ kind: "queueMonitorUnavailable" as const }); }
  }
  #now(): string {
    const value = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw unavailable(); return value;
  }
  async #current(signal: AbortSignal): Promise<QueueMonitorApproval | undefined> {
    if (signal.aborted) return undefined; const c = this.#config;
    const staff = await awaitUntilAbort(this.#staff.current(c.scope), signal), own = await awaitUntilAbort(this.#approval.current(c.scope), signal);
    if (!staff?.ok || !own?.ok || !own.value || signal.aborted) return undefined;
    const a = own.value;
    return a.policyVersion === c.policyVersion && a.businessId === c.businessId && a.recallTypeId === c.recallTypeId && a.timeZone === c.timeZone &&
      a.credentialFingerprint === clinikoCredentialFingerprint(c.apiKey) && a.pollEveryMinutes === c.pollEveryMinutes &&
      a.pollEveryMinutes <= staff.value.reviewCadenceMinutes && a.reviewOwnerRef === staff.value.reviewOwnerRef && a.reviewBackupRef === staff.value.reviewBackupRef &&
      a.destinationFingerprint === queueMonitorFingerprint(c.destination) && a.alertTokenFingerprint === queueMonitorFingerprint(c.alertTokenHex) ? a : undefined;
  }
  async run(external = new AbortController().signal): Promise<QueueMonitorResult> {
    if (this.#busy) return { status: "monitorBusy", accepted: 0, attempted: 0 };
    if (!(external instanceof AbortSignal) || external.aborted) return { status: "approvalUnavailable", accepted: 0, attempted: 0 };
    this.#busy = true; const controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 180_000); let accepted = 0, attempted = 0;
    try {
      const c = this.#config, initial = await this.#current(signal);
      if (!initial) return { status: "approvalUnavailable", accepted, attempted };
      const port: typeof fetch = async (input, init) => {
        if (signal.aborted || !await this.#current(signal)) throw unavailable();
        const value = await awaitUntilAbort((c.clinikoFetch ?? fetch)(input, { ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }), signal);
        if (!value) throw unavailable(); return value;
      };
      const pendingRead = collectClinikoRecallQueuePulse({ db: c.db, scope: { tenantId: c.scope.tenantId, clinicId: c.scope.clinicId },
        apiKey: c.apiKey, contactEmail: c.contactEmail, recallTypeId: c.recallTypeId, timeZone: c.timeZone, fetchPort: port,
        now: new Date(this.#now()), ...(c.sharedBudgetUserRef ? { sharedBudgetUserRef: c.sharedBudgetUserRef } : {}) });
      const pulse = await awaitUntilAbort(pendingRead.catch(() => undefined), signal);
      const approval = await this.#current(signal);
      if (!approval) return { status: "approvalUnavailable", accepted, attempted };
      const now = this.#now(), known = pulse && pulse.throughDate === clinicQueueDate(new Date(now), c.timeZone);
      const alerts: { kind: AggregateAlertKind; count: number; threshold: number }[] = known ? [
        { kind: "clinikoQueuePending" as const, count: pulse.pending, threshold: approval.pendingThreshold },
        { kind: "clinikoQueueOverdue" as const, count: pulse.overdue, threshold: approval.overdueThreshold },
      ].filter(a => a.count >= a.threshold) : [{ kind: "clinikoQueueUnavailable", count: 1, threshold: 1 }];
      for (const alert of alerts) {
        if (!await this.#current(signal)) return { status: "approvalUnavailable", accepted, attempted };
        const date = this.#now().slice(0, 10), alertKey = operationalAlertKey(c.scope, date, alert.kind, alert.threshold, c.alertTokenHex);
        attempted++;
        try {
          const response = await awaitUntilAbort((c.alertFetch ?? fetch)(c.destination, { method: "POST", redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), headers: { authorization: `Bearer ${c.alertTokenHex}`,
              "content-type": "application/json", "idempotency-key": alertKey },
            body: JSON.stringify({ schemaVersion: 1, date, ...alert, alertKey }) }), signal);
          await response?.body?.cancel();
          if (!response || response.status < 200 || response.status >= 300) throw unavailable(); accepted++;
        } catch { return { status: "deliveryUnavailable", accepted, attempted }; }
      }
      return known ? { status: "queueKnown", accepted, attempted, pending: pulse.pending, overdue: pulse.overdue }
        : { status: "queueUnavailable", accepted, attempted };
    } catch { return { status: "approvalUnavailable", accepted, attempted }; }
    finally { controller.abort(); clearTimeout(timer); this.#busy = false; }
  }
}
