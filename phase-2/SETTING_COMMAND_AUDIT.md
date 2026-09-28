# Booking setting command audit, version 0.1

The existing `settings.appointments.booking.enabled.change.v1` command now passes the host-bound actor reference into `PolicyStore`. A successful setting version records who changed the flag, its previous and new values, and a timestamp in the same PostgreSQL transaction as the policy version. A version conflict records no change. The in-memory reference store records the same fields for its lifetime; an embedded host must supply durable policy storage and authenticated actor binding.

`settings.appointments.booking.audit.v1` gives clinic admins a scoped, paged read of booking-setting changes. Staff and agent roles cannot discover or invoke it. The standalone dashboard uses that command to show history and refreshes it after a successful toggle. The response contains policy versions and actor references only, with no patient, appointment, or spoken content.

Migration `002_booking_setting_audit` adds nullable metadata columns to the existing append-only setting versions. Versions written before this migration remain readable as `legacyUnattributed`; Abby does not guess their actor, previous value, or timestamp. New changes record all three fields atomically. The schema remains the Phase 0/2 probe schema and is not yet a production upgrade contract.

Embedded and PostgreSQL command journeys cover default empty history, two changes, a rejected stale change, role filtering, cursor reads, scope isolation, and PostgreSQL reload. The browser journey covers toggle-to-history visibility and reload; view-only staff cannot read the audit endpoint. This audit covers the booking-setting command. Other administrative commands, host-authenticated agent sessions, and an independently approved staff actor policy remain open.
