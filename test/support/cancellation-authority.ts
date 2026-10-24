import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppointmentChangeAuthority } from "../../src/standalone/appointment-change-authority.ts";
import { ClinikoCancellationAuthority } from "../../src/standalone/cliniko-cancellation-authority.ts";
import { OwnerFileCancellationPolicy } from "../../src/standalone/owner-file-cancellation-policy.ts";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { cancellationFixture, cancellationNow } from "./standalone-cancellation.ts";
import type { CancellationScenario } from "./standalone-cancellation.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { LocationScope } from "../../src/core/model.ts";

export async function concreteCancellationFixture(options: { scope?: LocationScope; scenario?: CancellationScenario;
  budget?: PatientVerificationBudget; folder?: string; timeoutMs?: number; multiple?: boolean; startsAt?: string;
  noticeRanges?: CancellationApproval["noticeRanges"];
  onHeldTarget?: (signal: AbortSignal | undefined) => void } = {}) {
  const scope = options.scope ?? { tenantId: `authority-${crypto.randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "abby-cancellation-policy-"));
  const path = join(folder, "cancellation.json"), accountPath = join(folder, "accounts.json");
  const account = { email: "clinic-admin@example.test", actor: { actorRef: "synthetic-admin", role: "clinicAdmin", scope }, membershipVersion: "1" };
  const directory = new OwnerFileAdminDirectory(accountPath, scope);
  let record: CancellationApproval, source: ClinikoCancellationAuthority, policy: OwnerFileCancellationPolicy;
  let failure = "", holdExact = false, release: () => void = () => undefined;
  let heldTargetSignal: AbortSignal | undefined;
  let onRecall: () => Promise<void> = async () => undefined;
  let sourceTime = cancellationNow;
  const traffic: string[] = [];
  const replace = async (file: string, value: unknown) => { await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file); };
  try {
    await replace(accountPath, [account]);
    const f = await cancellationFixture(options.scenario ?? "success", options.budget ? () => options.budget! : undefined, {
      scope, fetchAround: port => async (value, init) => {
        const url = new URL(String(value)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
        if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: failure === "businessArchive" ? cancellationNow : null,
          time_zone_identifier: failure === "timeZone" ? "Asia/Jakarta" : "Australia/Sydney" });
        if (url.pathname === "/v1/individual_appointments") {
          const first = { id: "91",
          starts_at: options.startsAt ?? "2026-10-08T04:00:00.000Z", ends_at: options.startsAt ? new Date(Date.parse(options.startsAt) + 1_800_000).toISOString() : "2026-10-08T04:30:00.000Z", cancelled_at: null, deleted_at: null, archived_at: null,
          patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/42" } },
          business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } };
          const appointments = options.multiple ? [first, { ...first, id: "92", starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" }] : [first];
          return Response.json({ total_entries: appointments.length, individual_appointments: appointments });
        }
        const response = await port(value, init);
        if (url.pathname === "/v1/recalls" && method === "POST") await onRecall();
        if (url.pathname === "/v1/individual_appointments/91" && method === "GET") {
          if (holdExact) await new Promise<void>(resolve => {
            heldTargetSignal = init?.signal ?? undefined; release = resolve; options.onHeldTarget?.(heldTargetSignal);
          });
          const appointment = await response.json();
          if (options.startsAt) { appointment.starts_at = options.startsAt; appointment.ends_at = new Date(Date.parse(options.startsAt) + 1_800_000).toISOString(); }
          if (failure === "patient") appointment.patient.links.self = "https://api.au5.cliniko.com/v1/patients/43";
          if (failure === "business") appointment.business.links.self = "https://api.au5.cliniko.com/v1/businesses/12";
          if (failure === "foreignLink") appointment.practitioner.links.self = "https://foreign.example.test/v1/practitioners/22";
          if (failure === "type") appointment.appointment_type.links.self = "https://api.au5.cliniko.com/v1/appointment_types/34";
          if (failure === "practitioner") appointment.practitioner.links.self = "https://api.au5.cliniko.com/v1/practitioners/23";
          if (failure === "time") appointment.starts_at = "2026-10-08T05:00:00.000Z";
          if (failure === "archive") appointment.archived_at = cancellationNow;
          if (failure === "cancelled") appointment.cancelled_at = cancellationNow;
          if (failure === "missingField") delete appointment.deleted_at;
          if (failure === "server") return new Response(null, { status: 503 });
          if (failure === "oversize") return new Response(" ".repeat(1_000_001));
          return Response.json(appointment);
        }
        return response;
      },
      authorityFor: async (config, port): Promise<AppointmentChangeAuthority> => {
        record = { scope, revision: "cancellation-1", approverRef: "synthetic-admin", approvedAt: "2026-10-04T03:59:00.000Z",
          effectiveFrom: "2026-10-04T03:59:00.000Z", effectiveUntil: "2026-10-04T04:04:00.000Z", approved: true, enabled: true,
          policyVersion: config.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(config.apiKey),
          recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort", notificationOwner: "cliniko", cancellationReason: 50,
          lateNoticeHours: 24, maxAdvanceDays: 90,
          standardTerms: { version: "standard-1", approvedText: "A cancellation fee of $20 applies." },
          lateTerms: { version: "late-1", approvedText: "A late cancellation fee of $40 applies." },
          ...(options.noticeRanges ? { noticeRanges: options.noticeRanges } : {}) };
        await replace(path, record);
        policy = resultValue(await OwnerFileCancellationPolicy.capture({ path, ...config, credentialFingerprint: record.credentialFingerprint,
          recallTypeId: "7", timeZone: "Australia/Sydney", directory, clock: () => sourceTime }));
        source = resultValue(ClinikoCancellationAuthority.create({ ...config, policy, clock: () => sourceTime,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, port));
        return source;
      },
    });
    return { ...f, source: source!, feePolicy: policy!, path, accountPath, account, directory, traffic, get record() { return record; },
      get patches() { return f.patches; }, get appointmentReads() { return f.appointmentReads; }, get contactReads() { return f.contactReads; },
      replacePolicy: async (patch: Partial<CancellationApproval>) => { record = { ...record, ...patch }; await replace(path, record); },
      replaceAccount: async (value: unknown) => replace(accountPath, value),
      select: async (verificationRef: string) => resultValue(await source.list(scope, verificationRef, cancellationNow, "2026-10-09T04:00:00.000Z", cancellationNow)).appointments[0]!.appointmentRef,
      query: (verificationRef: string, targetRef: string) => ({ scope, callId: f.callId, sessionId: f.sessionId, policyVersion: record.policyVersion,
        kind: "cancel" as const, verificationRef, targetRef, patientId: "42", phase: "proposal" as const, now: cancellationNow, signal: new AbortController().signal }),
      setFailure: (value: string) => { failure = value; }, setHold: (value: boolean) => { holdExact = value; },
      get heldTargetSignal() { return heldTargetSignal; },
      setSourceTime: (value: string) => { sourceTime = value; },
      release: () => release(), setOnRecall: (value: () => Promise<void>) => { onRecall = value; },
      close: async () => { source.dispose(); f.host.dispose(); f.email.close(); f.proof.dispose(); if (!options.folder) await rm(folder, { recursive: true, force: true }); },
    };
  } catch (error) { if (!options.folder) await rm(folder, { recursive: true, force: true }); throw error; }
}
