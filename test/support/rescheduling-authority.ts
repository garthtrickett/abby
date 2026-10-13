import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoReschedulingAuthorityConfig } from "../../src/standalone/cliniko-rescheduling-authority.ts";
import { ClinikoReschedulingAuthority } from "../../src/standalone/cliniko-rescheduling-authority.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import { OwnerFileReschedulingPolicy } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import type { ReschedulingApproval, ApprovedPractitionerMove } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";
import { standaloneReschedulingFixture } from "./standalone-rescheduling.ts";

/** Concrete public policies/selection/verifier/SAM/review/write; independent permission, email and HTTP remain synthetic. */
export async function reschedulingAuthorityFixture(options: { scope?: LocationScope; folder?: string; fetchPort?: typeof fetch; rateBudget?: ClinikoRequestBudget;
  verificationBudget?: PatientVerificationBudget; timeoutMs?: number; operation?: PatientOperation; multiple?: boolean; lostMove?: boolean; startsAt?: string; cancellationExecute?: boolean;
  destinationPractitionerId?: string; sameTime?: boolean; practitionerMoves?: readonly ApprovedPractitionerMove[] } = {}) {
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "abby-move-authority-"));
  const path = join(folder, "rescheduling.json"), destinationPath = join(folder, "destination.json"), accountPath = join(folder, "accounts.json");
  let approval: ReschedulingApproval, destinationApproval: BookingApproval, source: ClinikoReschedulingAuthority;
  let sourceConfig: ClinikoReschedulingAuthorityConfig, sourceFetch: typeof fetch;
  let feePolicy: OwnerFileReschedulingPolicy, destinationPolicy: OwnerFileBookingPolicy, directory: OwnerFileAdminDirectory;
  let account: { email: string; actor: { actorRef: string; role: "clinicAdmin"; scope: LocationScope }; membershipVersion: string };
  let sourceTime = verificationNow, failure = "", starts = ["2026-10-08T05:00:00.000Z", "2026-10-08T06:00:00.000Z"];
  let onTimes = async () => {}, onBusiness = async () => {};
  const destinationId = options.destinationPractitionerId ?? "22";
  if (options.sameTime) starts = ["2026-10-08T04:00:00.000Z"];
  const replace = async (file: string, value: unknown) => { await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file); };
  try {
    const f = await standaloneReschedulingFixture({ ...options, folder,
      fetchAround: port => async (value, init) => {
        const url = new URL(String(value));
        if (url.pathname === "/v1/businesses/11") { await onBusiness(); return Response.json({ id: "11", archived_at: failure === "businessArchive" ? verificationNow : null,
          time_zone_identifier: failure === "zone" ? "Asia/Jakarta" : "Australia/Sydney", show_in_online_bookings: failure !== "businessOnline", appointment_type_ids: ["33"] }); }
        if (["/v1/practitioners/22", `/v1/practitioners/${destinationId}`].includes(url.pathname)) return Response.json({ id: url.pathname.split("/").at(-1), archived_at: null, active: failure !== "inactive",
          show_in_online_bookings: true, display_name: failure === "name" ? "Changed practitioner" : destinationId === "22" ? "Demo Practitioner" : "Demo Destination" });
        if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", archived_at: null, show_in_online_bookings: true,
          name: "Physiotherapy", duration_in_minutes: failure === "duration" ? 60 : 30 });
        if (url.pathname === "/v1/businesses/11/practitioners") { const ids = failure === "relationship" ? [destinationId === "22" ? "23" : "22"] : [...new Set(["22", destinationId])]; return Response.json({ total_entries: ids.length, practitioners: ids.map(id => ({ id })) }); }
        if (["/v1/practitioners/22/appointment_types", `/v1/practitioners/${destinationId}/appointment_types`].includes(url.pathname)) return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
        if (url.pathname.endsWith("/available_times")) {
          await onTimes();
          if (failure === "unavailable") return new Response(null, { status: 503 });
          const times = starts.filter(start => {
            const day = clinicDateAt("Australia/Sydney", new Date(start));
            return day >= url.searchParams.get("from")! && day <= url.searchParams.get("to")!;
          });
          return Response.json({ total_entries: times.length, available_times: times.map(appointment_start => ({ appointment_start })) });
        }
        if (url.pathname === "/v1/individual_appointments") {
          const first = { id: "91", starts_at: options.startsAt ?? "2026-10-08T04:00:00.000Z",
            ends_at: options.startsAt ? new Date(Date.parse(options.startsAt) + 1_800_000).toISOString() : "2026-10-08T04:30:00.000Z", cancelled_at: null, deleted_at: null, archived_at: null,
            patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } };
          const appointments = options.multiple ? [first, { ...first, id: "92", starts_at: "2026-10-08T06:00:00.000Z", ends_at: "2026-10-08T06:30:00.000Z" }] : [first];
          return Response.json({ total_entries: appointments.length, individual_appointments: appointments });
        }
        if (options.multiple && url.pathname === "/v1/individual_appointments/92") return Response.json({ id: "92", starts_at: "2026-10-08T06:00:00.000Z", ends_at: "2026-10-08T06:30:00.000Z",
          cancelled_at: null, deleted_at: null, archived_at: null,
          patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
          practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/22" } }, appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/33" } } });
        const response = await port(value, init);
        if (url.pathname === "/v1/individual_appointments/91" && (init?.method ?? "GET") === "GET") {
          const row = await response.json();
          if (options.startsAt && !row.starts_at?.includes("05:00")) { row.starts_at = options.startsAt; row.ends_at = new Date(Date.parse(options.startsAt) + 1_800_000).toISOString(); }
          if (failure === "type") row.appointment_type.links.self = "https://api.au5.cliniko.com/v1/appointment_types/34";
          if (failure === "practitioner") row.practitioner.links.self = "https://api.au5.cliniko.com/v1/practitioners/23";
          return Response.json(row);
        }
        return response;
      },
      authorityFor: async (config, port) => {
        account = { email: "clinic-admin@example.test", actor: { actorRef: "synthetic-admin", role: "clinicAdmin", scope: config.scope }, membershipVersion: "member-1" };
        await replace(accountPath, [account]); directory = new OwnerFileAdminDirectory(accountPath, config.scope);
        const common = { scope: config.scope, revision: "move-1", approverRef: account.actor.actorRef, approvedAt: "2026-10-04T05:59:00.000Z",
          effectiveFrom: "2026-10-04T05:59:00.000Z", effectiveUntil: "2026-10-04T06:04:00.000Z", approved: true, enabled: true,
          policyVersion: config.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(config.apiKey),
          recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort" as const, notificationOwner: "cliniko" as const };
        approval = { ...common, lateNoticeHours: 24, maxAdvanceDays: 90,
          standardTerms: { version: "move-standard-1", approvedText: "No fee applies to this move." },
          lateTerms: { version: "move-late-1", approvedText: "A late rescheduling fee of $40 applies." }, ...(options.practitionerMoves ? { practitionerMoves: options.practitionerMoves } : {}) };
        destinationApproval = { ...common, practitionerId: destinationId, appointmentTypeId: "33", serviceRef: "physiotherapy", bookingPolicyVersion: "destination-1",
          durationMinutes: 30, minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
        await replace(path, approval); await replace(destinationPath, destinationApproval);
        const clock = () => sourceTime;
        feePolicy = resultValue(await OwnerFileReschedulingPolicy.capture({ ...config, ...common, path, directory, clock }));
        destinationPolicy = resultValue(await OwnerFileBookingPolicy.capture({ ...config, ...destinationApproval, path: destinationPath, directory, clock }));
        sourceConfig = { ...config, practitionerId: destinationId, feePolicy, policy: destinationPolicy, clock,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }; sourceFetch = port;
        source = resultValue(ClinikoReschedulingAuthority.create(sourceConfig, port)); return source;
      } });
    return { ...f, source: source!, ownerPorts: { fetchPort: sourceFetch!, rateBudget: sourceConfig!.rateBudget }, feePolicy: feePolicy!, destinationPolicy: destinationPolicy!, path, destinationPath, directory: directory!, account: account!, accountPath,
      createSource: (patch: Partial<ClinikoReschedulingAuthorityConfig>) => ClinikoReschedulingAuthority.create({ ...sourceConfig, ...patch }, sourceFetch),
      get approval() { return approval; }, get destinationApproval() { return destinationApproval; }, get patches() { return f.patches; }, get claims() { return f.claims; },
      query: (verificationRef: string, targetRef: string, offerRef: string) => ({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
        policyVersion: f.sessionConfig.policyVersion, kind: "reschedule" as const, verificationRef, patientId: verificationCanaries[2]!,
        targetRef, offerRef, phase: "proposal" as const, now: sourceTime, signal: new AbortController().signal }),
      select: async (verificationRef: string) => {
        const targets = resultValue(await source.list(f.scope, verificationRef, verificationNow, "2026-10-09T06:00:00.000Z", sourceTime));
        const offers = resultValue(await source.listOffers(f.scope, verificationRef, "2026-10-08", "2026-10-08", sourceTime));
        return { targetRef: targets.appointments[0]!.appointmentRef, offerRef: offers.choices[0]!.offerRef };
      },
      proposeSelection: (proof: string, selection: { targetRef: string; offerRef: string }) => f.propose(proof, "proposal", selection.targetRef, selection.offerRef),
      replacePolicy: async (patch: Partial<ReschedulingApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
      replaceDestination: async (patch: Partial<BookingApproval>) => { destinationApproval = { ...destinationApproval, ...patch }; await replace(destinationPath, destinationApproval); },
      replaceAccount: (value: unknown) => replace(accountPath, value), setFailure: (value: string) => { failure = value; },
      setTime: (value: string) => { sourceTime = value; f.setTime(value); }, setStarts: (value: string[]) => { starts = value; },
      setOnTimes: (run: () => Promise<void>) => { onTimes = run; }, setOnBusiness: (run: () => Promise<void>) => { onBusiness = run; },
      close: async () => { source.dispose(); await f.close(); if (!options.folder) await rm(folder, { recursive: true, force: true }); } };
  } catch (error) { if (!options.folder) await rm(folder, { recursive: true, force: true }); throw error; }
}
