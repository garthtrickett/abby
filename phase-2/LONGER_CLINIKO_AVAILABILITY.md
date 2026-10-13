# Longer Cliniko availability: gap6 progress

## Implemented online searches

An independently approved booking policy may include:

```json
"availabilityPlan": { "mode": "online", "maxSearchDays": 90 }
```

The approval remains scoped to the exact clinic, credential, service, practitioner,
duration and policy version. Existing approvals keep their native range. Service
and practitioner catalogues may declare an automatic search extent up to90 days;
each selected service member needs sufficient current booking approval. The
existing minimum notice and maximum advance rules still govern actual offers.

The reader splits an approved range into disjoint seven-calendar-day windows,
with at most three windows in flight. Every window must finish and agree on
native selection, names and zone before any offer is published. The same request
budget and deadlines apply. Errors, incomplete pages, abort and metadata drift
cannot become a partial menu or a no-availability claim.

Explicit calendar pairs reach the booking path before clock-window parsing.
Invalid, past or reversed pairs require clarification; crossing years requires
explicit years. A date-range change retains earlier time filters. Longer menu
presentation receives its numeric bound from the trusted current host; legacy
evidence retains the seven-day display limit. Model prompt v25 may route dates
within the approved extent; it cannot supply the extent or change patient/native
authority. Earlier v24 real-model/acoustic evidence is historical.

Proposal and commit still re-read the chosen calendar day, current approval,
independent patient permission and exact native service/duration before sending.
Availability remains an observation, with the existing declared best-effort
booking and uncertainty/review contract.

## Verified evidence

`npm run typecheck` and `npm run build:voice-tests` passed. Fifty related checks
passed without failures or skips, including the compiled signed two-month
request, private TLS verification, exactly one type34 native booking on
20 November and private database/output canaries. Complete-source faults and
approval withdrawal before the final send are checked through the actual
protected offers source. E2E-356 is registered at manifest1.163/356 scenarios;
full carrier evidence remains planned.

Command:

```sh
bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/compiled-long-booking-search.test.ts test/voice/compiled-location-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/cliniko/long-booking-search.test.ts test/cliniko/booking-date-range-language.test.ts test/cliniko/booking-clinic-policy.test.ts test/cliniko/availability.test.ts test/voice/openai-clinical-intent.test.ts test/voice/compound-booking-constraints.test.ts test/voice/service-catalogue-booking.test.ts
```

Tracked job: `Abby gap6 approved range presentation and compiled final gate October13`.
Log: `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791895281436.log`.

Earlier gates exposed two serving gaps: a calendar pair was parsed as an
ambiguous clock/selection request, then a successfully read long range reached
the existing seven-day presentation bound. Exact calendar parsing and explicit
trusted-host presentation evidence fix these defects. The original caller
request, concurrency, deadlines and legacy bounds were retained. A qualification
command also named a nonexistent test path; the final command uses the existing
compound-constraint file. No earlier failure is counted as a pass.

## Offline services remain the next part of gap6

[Cliniko's available-time API](https://docs.api.cliniko.com/openapi/available-time)
respects online-booking settings and its native request-range limit. It cannot
establish an offline service's full calendar. Supporting that service needs a
separately approved calculation using the native
[daily roster](https://docs.api.cliniko.com/openapi/daily-availability),
[extra availability blocks](https://docs.api.cliniko.com/openapi/availability-block)
and all overlapping individual appointments, group appointments and
[unavailable blocks](https://docs.api.cliniko.com/openapi/unavailable-block).

The current official OpenAPI schema was inspected without clinic credentials or
patient access. Availability-block recurrence is raw rule data; recurring busy
records also expose repeat relationships. Weekday/recurrence, DST, native links,
pagination, cross-business practitioner conflicts and withdrawn source evidence
need explicit coverage. Incomplete or unsupported source interpretation must
deny the result. The chosen-day calculation must be repeated before proposal
and commit. No offline mode is accepted by the current approval decoder.

Gap6 is incomplete until that engine and its serving journeys are qualified.
Gaps7–13, real clinic/recipient acceptance, acoustic quality and carrier/CI gates
remain open. The full thirteen-gap objective remains active.
