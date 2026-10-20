# Longer Cliniko availability: gap6 progress

**Source navigation:** Karen source links in this document open the current owner-supplied local reference snapshot. Recorded inspection dates and historical commit IDs remain historical evidence; the uploaded snapshot has no verified commit identity and is not asserted to match those revisions. A historical path absent from the upload links to the reference root for investigation.

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

## Independently approved offline calendars

An explicit owner/admin approval can now select a separate source plan:

```json
"availabilityPlan": {
  "mode": "roster",
  "maxSearchDays": 30,
  "slotIntervalMinutes": 15,
  "weekdayOrigin": "sunday",
  "busyScope": "practitionerAllBusinesses"
}
```

The mode, grid and weekday mapping are approved data, not caller/model choices.
The mode never follows automatically from an online-disabled flag. Native
business/service/member relationships, active/archive state, duration, names,
zone, notice/advance limits and independent patient permissions remain checked.
The approval decoder retains exact keys and rejects malformed plans.

[Cliniko's available-time API](https://docs.api.cliniko.com/openapi/available-time)
respects online booking settings. The explicit offline path instead reads the
native [daily roster](https://docs.api.cliniko.com/openapi/daily-availability),
[extra availability](https://docs.api.cliniko.com/openapi/availability-block),
individual appointments, group appointments and
[unavailable blocks](https://docs.api.cliniko.com/openapi/unavailable-block).
Busy queries cover the practitioner across every business. Each source must be
complete and agree across two reads, followed by a fresh metadata check. Every
request shares the existing credential budget and deadline; no provider-supplied
next link is followed. Each read retains its ten-page/1,000-row limit. Oversized busy queries are
split into contiguous overlapping-interval queries; all halves must complete
and shared native records must agree. A dense leaf spanning at most24 hours,
excessive split depth, budget exhaustion or any incomplete half denies the
whole result. Additive roster/extra collections retain their original bound.

The calculator unions openings, preserves the opening's approved grid, removes
all overlapping busy intervals and requires the full appointment duration to
fit. Real UTC instants cover both DST folds without inventing spring-gap clocks.
Adjacent windows are joined before range filtering, so next-day capacity and
busy intervals govern midnight-spanning appointments. Only interval data and
public labels leave the reader; notes and patient relationships are not retained
in offers. Proposal and final send recalculate the chosen day.

### Qualification and remaining work

E2E-357 now has 34 passing focused source/calendar checks and three compiled
synthetic caller journeys: one inspected hour booking, missing group-busy data
preventing publication, and a slot occupied after proposal preventing sending.
The compiled gate also retained the longer online caller journey (four checks,
zero skips; log `4590eee3-1791897723307.log`). Final combined qualification passed source typecheck, compiled voice build and
86 checks with zero failures/skips in `4590eee3-1791898132162.log`. It includes
existing longer online, multi-location and integrated caller journeys plus
manifest1.164/357 IDs.

Earlier failures are retained: fixture spreads copied live counters as fixed
values, the legacy fixture accidentally received the default roster plan, and
a boundary test found next-day openings were filtered before merging. Corrected
fixtures preserve real write/status assertions; the calculator now retains the
next-day opening. Label-change tests inspect the protected authority response,
not the gateway's separate command-envelope acceptance. No runtime deadline,
concurrency, permission or source-completeness check was relaxed.

Recurrence interpretation is still unfinished: a non-null or missing
`repeat_rule` denies the source. The weekday convention requires explicit
approved mapping; the public schema alone does not establish that mapping.
Real-calendar recurrence/zone acceptance, larger calendar completeness and
full service/location serving coverage remain to qualify before gap6 can close.
Gaps7–13, real clinic/recipient acceptance, acoustic quality and carrier/CI gates
remain open. The full thirteen-gap objective remains active.

Final command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/compiled-roster-booking.test.ts test/voice/compiled-long-booking-search.test.ts test/voice/compiled-location-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/cliniko/roster-booking.test.ts test/cliniko/roster-calendar.test.ts test/cliniko/availability.test.ts test/cliniko/long-booking-search.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-clinic-policy.test.ts test/contract/scenario-manifest.test.ts
```

Tracked job: `Abby offline calendar final compiled and source qualification`,
exit0. These are local results; exact-head CI must execute before merge readiness.


## Larger calendars and serving coverage: E2E-358

Oversized busy ranges now adapt to complete smaller reads without raising the
existing page, deadline or credential-budget limits. Intervals crossing the
split appear in both queries and are deduplicated only when the same native ID
and interval agree. Two complete snapshots and fresh chosen-day reads remain
mandatory. No successful half can become a partial menu after another fails.
Tests include a late-range offer after more than1,000 group records, cross-site
busy data, changing boundary records, failed halves and exhausted budgets.

The compiled source now has coverage for returning North/South callers and
separate45/60-minute offline services, distinct TLS recipients and exact native
business/type/member bodies. A first-time South caller separately confirms
private registration and booking with an approved female member; private fields
and the code stay outside ordinary/model/database/output paths. A two-month
compiled caller reaches one inspected offline November booking after the large
busy read. Seven compiled offline journeys passed without skips (log
`4590eee3-1791899690164.log`). The initial broader gate passed46 of47 checks;
the first-time test incorrectly expected a prompt the existing workflow does
not emit. It now waits for the actual private code prompt, preserving the
production workflow and confirmation boundaries.

### Reference/provider contract findings

The [official daily schema](https://docs.api.cliniko.com/openapi/daily-availability)
currently enumerates0–6 without a textual weekday mapping. The inspected Karen
source at committed`cd592bec2f0c5630c1f559f6571c8b5724c7103d`
([calculator](/home/gust/code/karen-website-dev/server/src/services/cliniko/patients/customAvailabilityCalculatorService.ts))
records an ISO weekday convention from its native investigation and matches
Sunday7 as well as legacy0. Abby's Sunday-origin approved plan now accepts both
Sunday encodings and verifies that both produce the same clinic date. This is
source-based contract evidence and synthetic qualification; Abby did not read
production calendars or independently reproduce Karen's live investigation.

[Cliniko's repeating appointment guide](https://help.cliniko.com/en/articles/1777286-book-repeating-appointments)
describes calendar occurrences. The
[raw availability schema](https://docs.api.cliniko.com/openapi/availability-block/availabilityblock)
exposes repeat type, interval and count, but does not establish all raw count,
monthly-edge or DST interpretation needed for expansion. No recurrence
arithmetic is guessed from the UI guide. A patient-free sandbox availability
block plus its resulting dates has been requested asynchronously; independent
work continues. Non-null/missing recurrence rules still deny results. Large
historical additive collections and real provider/clinic acceptance remain open.

The initial combined regression passed97 checks without failures/skips in
`4590eee3-1791899864899.log`. A subsequent focused red witness
(`4590eee3-1791900225372.log`) proved that a disappearing split record was not
being compared with the parent total. The reader now requires deduplicated
child counts to equal each oversized parent count; seven focused source checks
passed with the original missing-record expectation
(`4590eee3-1791900385612.log`). The earlier final attempt stopped at typecheck
because constructor parameter properties are not allowed by erasableSyntaxOnly;
it was changed to an explicit field assignment. Final qualification for that
current source passed typecheck, compiled voice build, diff check and98 tests
with zero failures/skips in `4590eee3-1791900442880.log`. No source-completeness, concurrency or deadline check was relaxed.


Final E2E-358 command:

```sh
npm run typecheck && npm run build:voice-tests && bash scripts/with-postgres.sh node --test --test-concurrency=4 test/voice/compiled-roster-coverage.test.ts test/voice/compiled-roster-booking.test.ts test/voice/compiled-long-booking-search.test.ts test/voice/compiled-location-runner.test.ts test/voice/integrated-clinical-runner.test.ts test/cliniko/roster-large-calendar.test.ts test/cliniko/roster-booking.test.ts test/cliniko/roster-calendar.test.ts test/cliniko/availability.test.ts test/cliniko/long-booking-search.test.ts test/cliniko/booking-offers.test.ts test/cliniko/booking-clinic-policy.test.ts test/contract/scenario-manifest.test.ts test/contract/no-number-gap-trace.test.ts && git diff --check
```

Tracked job: `Abby adaptive offline parent count corrected full gate`, exit0.
Manifest1.165 retains358 stable IDs. This is local engineering evidence; cloud
CI, recurrence interpretation, additive historical-volume and real clinic/mail,
acoustic and carrier acceptance remain open. The full13 objective is active.


## Dated native recurring busy records, E2E-404

An independently approved roster policy can now include:

```json
"availabilityPlan": {
  "mode": "roster",
  "maxSearchDays": 90,
  "slotIntervalMinutes": 15,
  "weekdayOrigin": "sunday",
  "busyScope": "practitionerAllBusinesses",
  "busyRecurrence": "nativeOccurrences"
}
```

This mode uses the dated busy occurrences returned by native individual/group
appointment and unavailable-block collections. Each has its own native identity
and actual start/end instants. Only those intervals are subtracted; repeat_rule
is validated metadata rather than a source of generated dates. The supported
shape has Daily/Weekly/Monthly type, a positive safe repeat count (or null),
and an integer interval from1 to100. Counts do not supply booking authority.

The provider documents dated resources, repeat metadata and related occurrences:
[individual appointments](https://docs.api.cliniko.com/openapi/individual-appointment/individualappointment),
[group appointments](https://docs.api.cliniko.com/openapi/group-appointment/listgroupappointments-get),
and [unavailable blocks](https://docs.api.cliniko.com/openapi/unavailable-block/listunavailableblocks-get).
The provider's [downloadable OpenAPI schema](https://docs.api.cliniko.com/_bundle/openapi.json?download),
retrieved14October2026, SHA-256
`4c354b3cb3fb9cf7ca91b5dd408b78f62896c62b89d265ba3190e5d2bd03740c`,
establishes those rule bounds. Null type/interval and incomplete rule objects
remain outside this supported subset; the reader never fills in their meaning.
This opt-in must be accepted against the deploying clinic's native occurrence
collections and full requested horizon before activation. Local synthetic
contract evidence does not replace that clinic acceptance.

Legacy plans retain their former source restrictions. Wrong/implicit values do
not grant the new scope. Every native page and all busy families/businesses must
remain complete and stable; large collections retain adaptive range splitting.
The selected day is read again under current approval before writing. Private
notes and patient associations do not leave the reader. Approval withdrawal,
malformed rules, calendar drift and new native conflicts deny the send.

Availability blocks that define extra opening hours still require repeat_rule
null. Their expansion/count/month-end/DST semantics remain unqualified. No
missing native occurrence is synthesized or inferred from an existing rule, and
full recurrence support and real-calendar acceptance remain open.


## Historical source navigation inventory

Client application paths use the `/home/gust/code/karen-client` alias; other paths use `/home/gust/code/karen-website-dev`. Paths describe the inspected source layout, while presence refers only to the current upload.

| Historical commit | Source path | Current snapshot |
| --- | --- | --- |
| `cd592bec2f0c5630c1f559f6571c8b5724c7103d` | `server/src/services/cliniko/patients/customAvailabilityCalculatorService.ts` | Present |
