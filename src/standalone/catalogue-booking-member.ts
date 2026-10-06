import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { ClinikoBookingAuthority } from "./cliniko-booking-authority.ts";
import { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";

/** Bind actual provider labels and the approved location into the exact action
 * digest. The member writer remains bound to its separately approved IDs. */
export function catalogueBookingAuthority(source: ClinikoBookingOffers, catalogue: OwnerFileBookingCatalogue,
  scope: LocationScope, practitionerId: string): ClinikoBookingAuthority {
  return { async resolve(query) {
    const denied = () => err({ kind: "unavailable" as const, target: "offer" as const });
    const before = await catalogue.current(scope);
    if (!before.ok || query.signal.aborted) return denied();
    const member = before.value.practitioners.find(item => item.practitionerId === practitionerId);
    if (!member) return denied();
    const read = await source.resolve(query), after = await catalogue.current(scope);
    if (!read.ok || !after.ok || query.signal.aborted || read.value.offer.presentation?.practitionerName !== member.name ||
        read.value.offer.presentation.appointmentTypeName !== before.value.appointmentTypeName) return denied();
    return ok({ ...read.value, offer: { ...read.value.offer, presentation: { ...read.value.offer.presentation, locationName: before.value.locationName } } });
  } };
}
