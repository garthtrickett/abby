# Phase 0 Cliniko evidence

**Status:** Discovery in progress. Documentation evidence is separate from account-probe evidence. No write has been attempted.

**Account profile:** User-supplied demo account; API key and login credentials are excluded from this repository. The read-only probe records only a shard, HTTP status, and aggregate count. An account permission or safe-write conclusion requires its own evidence.

| Evidence ID | Claim supported by current evidence | Source and observation | Limit |
| --- | --- | --- | --- |
| C-DOC-01 | Cliniko API keys use HTTP Basic authentication as the username; permissions follow the key's user. A named contact User-Agent is required. | [Official API introduction](https://docs.api.cliniko.com/) | Documentation, not an account permission test. |
| C-DOC-02 | The key suffix selects the API shard; requests must use that shard's host. | [Official sharding guide](https://docs.api.cliniko.com/guides/sharding) | The probe derives the host from the suffix and does not print the key. |
| C-DOC-03 | API calls are limited to 200 per minute per user and 429 includes a reset timestamp. | [Official API introduction](https://docs.api.cliniko.com/) | The probe makes four sequential GET requests and does not test the limit. |
| C-DOC-04 | Available times are host-calculated and respect online-booking settings. The endpoint requires business, practitioner, appointment type, and a bounded date range. | [Official Available Time reference](https://docs.api.cliniko.com/openapi/available-time) | Does not establish this account's eligible combinations or whether a returned time remains available at write time. |
| C-DOC-05 | Individual appointments have list, create, read, update, and cancel operations; list filtering includes patient, business, practitioner, start time, and creation time. | [Official Individual Appointment reference](https://docs.api.cliniko.com/openapi/individual-appointment) | The documented operations alone do not prove a stable idempotency key, exact lost-response reconciliation, or atomic rescheduling. |
| C-LIVE-01 | The demo API key can read business, appointment-type, practitioner, and individual-appointment list metadata. | 2026-09-28, `cliniko_readonly_v1`, shard `au5`: all four GET requests returned 200; aggregate counts were 1, 2, 1, and 0 respectively. | These reads do not establish patient access or write permission. No response record or identifier was retained. |
| C-LIVE-02 | The demo business is not currently exposed in online bookings, and this probe cannot fetch offers. | 2026-09-28: business `show_in_online_bookings=false`; both listed appointment types and the practitioner reported `true`; the two available-time GET requests each returned 404. | The business flag is consistent with the [documented online-booking gate](https://docs.api.cliniko.com/openapi/available-time), but the exact cause of 404 has not been isolated. No offer or booking support is proven. |

## Current capability classification

| Capability | Phase 0 state | Reason and next proof |
| --- | --- | --- |
| Clinic context and appointment-type reads | Observed metadata access | Verify the exact fields needed by `ClinicContext` without storing patient data or promoting write permissions. |
| Available-time search | Not ready in this demo configuration | The business online-booking flag is false and both bounded reads returned 404. Determine the account setting and retest a known eligible combination before classifying support. |
| Patient lookup and verification | Unverified | Specify clinic-approved verification before any patient-record probe or disclosure. |
| Booking | Request-only until proven safe | Confirm account write permission, offer revalidation, current authorization at commit, and exact outcome after a lost response using synthetic records. |
| Cancellation | Request-only until proven safe | Prove target binding, definitive cancel outcome, and exact lost-response recovery on a synthetic appointment. |
| Rescheduling | Request-only until proven safe | Demonstrate a host-native atomic update and exact recovery; never implement cancel-then-book. |
| First-time intake | Request-only until proven safe | Demonstrate approved consent, duplicate checking, a stable patient reference, and exact recovery. |

The approved support matrix is a later Phase 0 output. A documented endpoint or successful GET does not promote any mutation to executable support. No mutation probe runs until its synthetic fixture, expected after-state, and cleanup/reconciliation method are written down.

## Read-only account probe

Run `python3 phase-0/probes/cliniko_readonly.py` in an interactive terminal. The script prompts for a contact email and hidden API key, makes four allowlisted metadata GET requests and up to two bounded available-time GET requests, and prints only HTTP status, aggregate counts, and online-booking booleans. It does not read from an environment file, persist credentials, or print API response records. A 404 offer probe makes its process exit nonzero while preserving the successful metadata results.

**Result:** C-LIVE-01 and C-LIVE-02 above. Next account probe requires a known online-booking-eligible business, practitioner, and appointment type. Do not infer safe writes from these results.
