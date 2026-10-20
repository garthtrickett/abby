import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocationScope } from "../../src/core/model.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";
import type { ClinikoBookingOffersConfig } from "../../src/standalone/cliniko-booking-offers.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoBookingOffers } from "../../src/standalone/cliniko-booking-offers.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { standaloneBookingFixture } from "./standalone-booking.ts";
import { verificationNow } from "./caller-verification.ts";

export async function bookingOffersFixture(options: { fetchAround?: (port: typeof fetch) => typeof fetch; budget?: ClinikoRequestBudget; timeoutMs?: number; scope?: LocationScope; verificationBudget?: PatientVerificationBudget; fetchPort?: typeof fetch; folder?: string; offerTtlSeconds?: number; availabilityPlan?: BookingApproval["availabilityPlan"]; maxAdvanceDays?: number; appointmentChanges?: true } = {}) {
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "abby-booking-offers-")), path = join(folder, "booking.json"), accountPath = join(folder, "accounts.json");
  let sourceConfig: ClinikoBookingOffersConfig, sourceFetch: typeof fetch;
  let approval: BookingApproval, source: ClinikoBookingOffers, policy: OwnerFileBookingPolicy, directory: OwnerFileAdminDirectory;
  let account: { email: string; actor: { actorRef: string; role: "clinicAdmin"; scope: { tenantId: string; clinicId: string; locationId: string } }; membershipVersion: string };
  let failure = "", sourceTime = verificationNow, starts = ["2026-10-08T04:00:00.000Z", "2026-10-08T05:00:00.000Z", "2026-10-08T06:00:00.000Z", "2026-10-08T07:00:00.000Z"];
  const traffic: string[] = [];
  let onTimes: () => Promise<void> = async () => undefined, onContact: () => Promise<void> = async () => undefined;
  const replace = async (file: string, value: unknown) => { await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file); };
  try {
    const f = await standaloneBookingFixture({ ...(options.appointmentChanges ? { appointmentChanges: true } : {}), ...(options.fetchPort ? { fetchPort: options.fetchPort } : {}), ...(options.scope ? { scope: options.scope } : {}), ...(options.verificationBudget ? { verificationBudget: options.verificationBudget } : {}), ...(options.budget ? { rateBudget: options.budget } : {}),
      fetchAround: port => { const base: typeof fetch = async (value, init) => {
        const url = new URL(String(value)); traffic.push(`${init?.method ?? "GET"} ${url.pathname}`);
        assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
        if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: failure !== "businessOnline",
          archived_at: failure === "businessArchive" ? verificationNow : null, appointment_type_ids: failure === "businessType" ? [] : ["33"],
          time_zone_identifier: failure === "zone" ? "Asia/Jakarta" : "Australia/Sydney" });
        if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: failure !== "inactive",
          show_in_online_bookings: failure !== "practitionerOnline", archived_at: failure === "practitionerArchive" ? verificationNow : null,
          display_name: failure === "practitionerName" ? "Changed practitioner" : "Demo Practitioner" });
        if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: failure !== "typeOnline",
          archived_at: failure === "typeArchive" ? verificationNow : null, duration_in_minutes: failure === "duration" ? 60 : 30,
          name: failure === "typeName" ? "Changed service" : "Physiotherapy" });
        if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: failure === "relationship" ? "23" : "22" }] });
        if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: failure === "typeRelationship" ? "34" : "33" }] });
        if (url.pathname.endsWith("/available_times")) {
          await onTimes();
          if (failure === "server") return new Response(null, { status: 503 });
          const times = starts.filter(start => { const day = clinicDateAt("Australia/Sydney", new Date(start)); return day >= url.searchParams.get("from")! && day <= url.searchParams.get("to")!; });
          return Response.json({ total_entries: times.length, available_times: times.map(appointment_start => ({ appointment_start })) });
        }
        const result = await port(value, init); if (url.pathname.startsWith("/v1/patients/")) await onContact(); return result;
      }; return options.fetchAround ? options.fetchAround(base) : base; },
      authorityFor: async (config, port) => {
        account = { email: "clinic-admin@example.test", actor: { actorRef: "synthetic-admin", role: "clinicAdmin", scope: config.scope }, membershipVersion: "1" };
        await replace(accountPath, [account]); directory = new OwnerFileAdminDirectory(accountPath, config.scope);
        approval = { scope: config.scope, revision: "booking-1", approverRef: account.actor.actorRef,
          approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: "2026-10-04T05:59:00.000Z", effectiveUntil: "2026-10-04T06:04:00.000Z",
          enabled: true, approved: true, policyVersion: config.policyVersion, businessId: "11", practitionerId: "22", appointmentTypeId: "33",
          credentialFingerprint: clinikoCredentialFingerprint(config.apiKey), recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort",
          notificationOwner: "cliniko", serviceRef: "physiotherapy", bookingPolicyVersion: "book-policy-1", durationMinutes: 30,
          minNoticeMinutes: 60, maxAdvanceDays: options.maxAdvanceDays ?? 30, offerTtlSeconds: options.offerTtlSeconds ?? 120,
          ...(options.availabilityPlan ? { availabilityPlan: options.availabilityPlan } : {}) };
        await replace(path, approval);
        policy = resultValue(await OwnerFileBookingPolicy.capture({ path, ...config, credentialFingerprint: approval.credentialFingerprint,
          recallTypeId: "7", timeZone: "Australia/Sydney", directory, clock: () => sourceTime }));
        sourceConfig = { ...config, policy, clock: () => sourceTime, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }; sourceFetch = port;
        source = resultValue(ClinikoBookingOffers.create(sourceConfig, port));
        return source;
      } });
    return { ...f, source: source!, ownerPorts: { fetchPort: sourceFetch!, rateBudget: sourceConfig!.rateBudget }, bookingPolicy: policy!, directory: directory!, path, accountPath, account: account!, allTraffic: traffic,
      createSource: (patch: Partial<ClinikoBookingOffersConfig>, fetchPort: typeof fetch = sourceFetch) => ClinikoBookingOffers.create({ ...sourceConfig, ...patch }, fetchPort),
      freshSource: () => resultValue(ClinikoBookingOffers.create(sourceConfig, sourceFetch)),
      get approval() { return approval; }, get posts() { return f.posts; }, get claims() { return f.claims; },
      replacePolicy: async (patch: Partial<BookingApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
      replaceAccount: (value: unknown) => replace(accountPath, value),
      list: (proof: string, from = "2026-10-08", to = "2026-10-08") => source.list(f.scope, proof, from, to, sourceTime),
      query: (proof: string, offerRef: string) => ({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
        patientId: f.evidence.patientId, verificationRef: proof, offerRef, phase: "proposal" as const, now: sourceTime, signal: new AbortController().signal }),
      setFailure: (value: string) => { failure = value; }, setTime: (value: string) => { sourceTime = value; f.setTime(value); }, setStarts: (value: string[]) => { starts = value; },
      setOnContact: (run: () => Promise<void>) => { onContact = run; },
      setOnTimes: (run: () => Promise<void>) => { onTimes = run; },
      close: async () => { source.dispose(); await f.close(); if (!options.folder) await rm(folder, { recursive: true, force: true }); } };
  } catch (error) { if (!options.folder) await rm(folder, { recursive: true, force: true }); throw error; }
}
