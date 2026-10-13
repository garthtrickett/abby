import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import { ClinikoBookingMenu } from "./cliniko-booking-menu.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import { ClinikoBookingHost } from "./cliniko-booking-host.ts";
import { ClinikoCatalogueBookingHost } from "./cliniko-catalogue-booking-host.ts";
import { catalogueBookingAuthority } from "./catalogue-booking-member.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";
import type { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import type { CallerVerificationSession } from "./caller-verification-session.ts";

export type ApprovedBookingComposition = Readonly<{ offers: ClinikoBookingOffers;
  host: ClinikoBookingHost | ClinikoCatalogueBookingHost; dispose(): void }>;
type Config = Pick<ClinikoBookingSessionConfig, "receipt" | "sessionId" | "policyVersion" | "cliniko" | "ledger" | "policies" | "bookingApprovalPath" | "directory" | "catalogue" | "timeoutMs" | "fetchPort"> & Readonly<{ clock: () => string }>;

/** Share exact approved member selection and native write guards for returning
 * and newly registered patients; the caller owns the operation-specific proof. */
export async function createApprovedBookingComposition(config: Config, terms: OwnerFileBookingPolicy,
  verification: Pick<CallerVerificationSession, "proof" | "verified">,
  catalogue: OwnerFileBookingCatalogue | undefined, stopped: () => boolean) {
  const denied = () => err({ kind: "bookingCompositionUnavailable" as const });
  const resources: Readonly<{ dispose(): void }>[] = [];
  const dispose = () => { for (const resource of resources) resource.dispose(); };
  let authority: ClinikoBookingOffers | undefined, menu: ClinikoBookingMenu | undefined;
  let host: ClinikoBookingHost | ClinikoCatalogueBookingHost | undefined, completed = false;
  const scope = config.receipt.scope, fetchPort = config.fetchPort ?? fetch;
  try {
    const profile = catalogue ? await catalogue.current(scope) : undefined;
    if (config.catalogue && (!profile?.ok || profile.value.practitioners[0]?.practitionerId !== config.cliniko.practitionerId ||
      config.catalogue.practitioners.length !== profile.value.practitioners.length ||
      config.catalogue.practitioners.some((member, index) => member.practitionerId !== profile.value.practitioners[index]?.practitionerId ||
        typeof member.bookingApprovalPath !== "string" || !member.bookingApprovalPath.trim()) ||
      config.catalogue.practitioners[0]?.bookingApprovalPath !== config.bookingApprovalPath)) return denied();
    if (stopped()) return denied();
    const source = ClinikoBookingOffers.create({ ...config.cliniko, scope, callId: config.receipt.callId,
      sessionId: config.sessionId, policyVersion: config.policyVersion, proof: verification.proof,
      policy: terms, clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }, fetchPort);
    const booking = ClinikoBookingWriter.create({ ...config.cliniko, scope }, fetchPort, config.clock);
    const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope }, fetchPort);
    if (!source.ok || !booking.ok || !recalls.ok || stopped()) return denied();
    authority = source.value; resources.push(authority);
    menu = new ClinikoBookingMenu({ verification, offers: authority, scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion });
    resources.push(menu);
    host = new ClinikoBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
      policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof, authority: catalogue ? catalogueBookingAuthority(authority, catalogue, scope, config.cliniko.practitionerId) : authority,
      menu,
      timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, writer: booking.value,
      recallWriter: recalls.value, clock: config.clock });
    resources.push(host);
    if (config.catalogue && catalogue && profile?.ok) {
      const members = [{ practitionerId: config.cliniko.practitionerId, name: profile.value.practitioners[0]!.name, host }];
      for (const [index, member] of config.catalogue.practitioners.entries()) {
        if (index === 0) continue;
        const selection = { ...config.cliniko, practitionerId: member.practitionerId };
        const terms = await OwnerFileBookingPolicy.capture({ path: member.bookingApprovalPath, scope,
          policyVersion: config.policyVersion, ...selection, credentialFingerprint: clinikoCredentialFingerprint(selection.apiKey), directory: config.directory, clock: config.clock,
          ...(config.catalogue.serviceBinding ? { serviceBinding: config.catalogue.serviceBinding } : {}) });
        if (!terms.ok || stopped()) return denied();
        const offers = ClinikoBookingOffers.create({ ...selection, scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, proof: verification.proof, policy: terms.value, clock: config.clock }, fetchPort);
        const writer = ClinikoBookingWriter.create({ ...selection, scope }, fetchPort, config.clock);
        if (!offers.ok || !writer.ok || stopped()) return denied();
        resources.push(offers.value);
        const selectionMenu = new ClinikoBookingMenu({ verification, offers: offers.value, scope, callId: config.receipt.callId,
          sessionId: config.sessionId, policyVersion: config.policyVersion }); resources.push(selectionMenu);
        const selectionHost = new ClinikoBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof,
          authority: catalogueBookingAuthority(offers.value, catalogue, scope, member.practitionerId), menu: selectionMenu,
          timeZone: selection.timeZone, recallTypeId: selection.recallTypeId, writer: writer.value,
          recallWriter: recalls.value, clock: config.clock }); resources.push(selectionHost);
        members.push({ practitionerId: member.practitionerId, name: profile.value.practitioners[index]!.name, host: selectionHost });
      }
      host = new ClinikoCatalogueBookingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
        ledger: config.ledger, catalogue, members, ...(config.catalogue.initialSearchPreference ? { initialPreference: config.catalogue.initialSearchPreference } : {}) });
    }
    if (!authority || !host || stopped()) return denied();
    if (!resources.includes(host)) resources.push(host); completed = true;
    return ok({ offers: authority, host, dispose } satisfies ApprovedBookingComposition);
  } catch { return denied(); }
  finally { if (!completed) dispose(); }
}
