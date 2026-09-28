# Cliniko read-only availability adapter, version 0.1

`ClinikoAvailabilityReader` binds a Cliniko API key, location scope, business, practitioner, and appointment type at construction. It derives the shard from the key suffix and sends authenticated HTTPS `GET` requests with Abby's contact User-Agent. It never sends a mutation request. A cross-scope call or invalid date range is rejected before HTTP.

For an availability request, the adapter reads the business, practitioner, and appointment-type online-booking flags. A `false` flag returns `notEligible` without querying times; an unknown flag or malformed record fails closed. It then reads all bounded available-time pages, checking count consistency and each timestamp. Results are explicitly `reservable: false`: a displayed time is neither a hold nor `BookableOffer` evidence for a host write. Rate limits, permission failure, missing resources, provider outage, and malformed data remain distinct typed outcomes. Redirects are disabled, and response bodies and pagination are bounded.

The provider contract suite uses a fake HTTP transport and runs in parallel with the text and PostgreSQL suites. It covers shard/auth headers, multi-page reads, each online-booking flag, cross-tenant rejection, invalid ranges, typed provider faults, oversized responses, and inconsistent pages. Run `npm test` and `npm run probe:postgres`.

This adapter has not yet been invoked through a live Abby call or re-probed against the demo account. It does not verify a patient, issue a stable offer, reserve a slot, or implement Cliniko writes. Cliniko booking therefore remains request-only in the draft support matrix. Before caller-facing availability is enabled, the product needs approved time-zone wording, a current account probe, a route and permission mapping, and a full call E2E that proves the spoken result and fallback.

The request shape and online-booking behavior follow Cliniko's [API introduction](https://docs.api.cliniko.com/), [sharding guide](https://docs.api.cliniko.com/guides/sharding), and [Available Time reference](https://docs.api.cliniko.com/openapi/available-time).
