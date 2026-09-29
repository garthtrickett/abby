# Phase 0 working set

The [execution plan](../PHASE_0_EXECUTION_PLAN.md) is the gate. These files are evidence and proposed decisions in progress; none is a Phase 0 sign-off.

| Package | Current state | Evidence or next step |
| --- | --- | --- |
| P0-01 call evidence | Source-flow inventory drafted; real-call corpus incomplete | [Call cases](CALL_CASES.md). Select de-identified calls and confirm source policy with clinic owners. |
| P0-02 product decisions | Product owner fixed the patient-data boundary and disabled patient-specific handoff pending clinic approval; clinic-specific verification and workflow decisions remain open | [Decision register](DECISIONS.md). Obtain clinic approval and proof before enabling dependent behavior. |
| P0-03 Cliniko | All 223 published operations inventoried; receptionist reads and controlled synthetic writes probed; execution still unapproved | [API inventory](CLINIKO_API_SURFACE.md) and [Cliniko evidence](CLINIKO_EVIDENCE.md). The demo business defaults to online booking off; safe lost-response and commit-time rules remain unproven. |
| P0-04 Splose | Unverified; no account available | [Draft support matrix](SUPPORT_MATRIX.md). Keep every Splose claim unverified until an account/profile can be probed. |
| P0-05 media and fallback | Deferred during the text-first checkpoint; provider/account not selected | The [text test plan](TEXT_TEST_PLAN.md) advances call/action contracts. Playback, transfer, and fallback remain required before full Phase 0 sign-off or live-call readiness. |
| P0-06 to P0-10 | TXT-01 through TXT-09 run against memory and disposable PostgreSQL; a [reference host composition](REFERENCE_HOST_CONTRACT.md) exercises booking, one setting, and staff fallback in standalone and embedded forms. The proposed [portable archive contract](PORTABLE_ARCHIVE_CONTRACT.md) defines the P0-08 export/import boundary. | Run `npm test` and `npm run probe:postgres`. The archive implementation, final contracts, and full-call E2E remain open. |

The [scenario manifest](SCENARIO_MANIFEST.md) tracks all current E2E IDs and maps the current agent catalogue and settings. Only the standalone availability case has passing text-only evidence in that registry; full-call evidence remains planned.

The Cliniko [read-only probe](probes/cliniko_readonly.py) prompts for its key in a terminal. Credentials and provider response records are not committed. A 200 GET proves only that this key can perform that read; it does not prove safe automation or write permission.

## Local text availability entrypoint

`npm run text:availability` accepts one JSON request on stdin: `{"text":"Do you have an opening?","from":"2026-10-02","to":"2026-10-02"}`. It requires `DATABASE_URL`, `ABBY_TENANT_ID`, `ABBY_CLINIC_ID`, `ABBY_LOCATION_ID`, `ABBY_CLINIKO_API_KEY`, `ABBY_CLINIKO_CONTACT_EMAIL`, `ABBY_CLINIKO_BUSINESS_ID`, `ABBY_CLINIKO_PRACTITIONER_ID`, and `ABBY_CLINIKO_APPOINTMENT_TYPE_ID` in the environment. Use a dedicated, freshly migrated standalone database: a startup preflight refuses known rich reference call, event, setting, knowledge, voice-lease, and work rows before it reads a caller question or contacts Cliniko. The response is one JSON line with an availability status and transient message. The command writes no caller text, patient details, appointment IDs, or offered times to Abby's database. It accepts at most 8 KiB of input and a seven-day date span. It is a local text probe; stdout acceptance is recorded as text presentation, not proof the caller read it. Booking, appointment disclosure or changes, and patient-specific staff handoff remain disabled. The latter requires the clinic approval and workflow proof in [D-07](DECISIONS.md).
