# Cliniko voice workflow checkpoint

Date: 2026-10-05. Branch: `codex/abby-cliniko-call-flow`.

## Current scope

The actual standalone transient voice composition can now host one admitted
Cliniko workflow: returning-patient booking, cancellation or rescheduling, or
private new-patient registration followed by independently permitted booking.
This is an explicit trusted host configuration. The runnable production CLI
does not enable it.

`ClinikoCallFlow` selects the concrete owner after admission and retains its
operation-specific verification, current policy, permission, review and
single-send checks. A canceled setup releases routing immediately; a late
construction cannot publish authority or send verification mail.

Returning-patient codes use private keypad input. New-patient registration
plays recovery terms, then a separate acknowledgment prompt. It collects
fields through a separate transient transcription adapter and plays an exact
readback. Fields never become ordinary model or SAM caller turns. During code
entry both ordinary and private field transcription are blocked. Fresh quiet
audio is required before ordinary conversation resumes.

Private presentation text stays in the voice owner's transient map. SAM tracks
an opaque presentation ID and accepts only the matching real transport playback
receipt. No private text is stored in its presentation or caller-message fields.

Registration and booking have different permissions, played confirmations and
affirmations. A successful registration does not implicitly book. Lost
appointment responses remain uncertain and cannot be replayed by another yes.
Patient-specific durable work remains in Cliniko; Abby's database retains only
the previously authorized phone-to-patient-ID index.

## Verified local evidence

- The unified workflow/session/private-keypad regression command passed all
  53 tests:
  `node --test --test-concurrency=4 test/cliniko/cliniko-call-flow.test.ts test/cliniko/booking-session.test.ts test/cliniko/cancellation-session.test.ts test/cliniko/rescheduling-session.test.ts test/cliniko/intake-booking-session.test.ts test/voice/private-keypad-verification.test.ts`.
- The signed workflow suite passed all 11 tests before adding the separate
  consent-decline cases. It uses genuine signed HTTP/WebSocket ingress, actual
  serving composition and SAM, played confirmations, concurrent calls,
  lost responses, interruption through a returned clear fence, disconnect and
  PostgreSQL privacy scans:
  `node --test test/voice/cliniko-workflow-call.test.ts`.
- The added private consent-decline group passed its parent and both cases:
  `node --test --test-name-pattern=E2E-302 test/voice/cliniko-workflow-call.test.ts`.
  A digit or speech before recovery playback cannot acknowledge consent;
  decline and disconnect create no verification email, patient, recall or booking.
- Stable scenario IDs `E2E-297` through `E2E-304` record the call owner, signed
  voice journeys, structured model routing and adversarial model cases in the
  technical design and manifest version 1.99.
- `node --test --test-concurrency=2 test/voice/openai-clinical-intent.test.ts
  test/voice/clinical-model-workflow-call.test.ts` passed 10 tests with a
  synthetic Responses port. Malformed, forged, cross-phase, oversized,
  refused and canceled responses cannot mint patient authority. The six signed
  synthetic model journeys route all four workflows and make SAM restate
  confirmed or uncertain outcomes; a second `Yes` after uncertainty never
  sends again.
- The opt-in live model evaluation ran with `gpt-4o-mini`, the owner-only API
  key and synthetic clinic data. The current v5 prompt passed a five-case
  public-language classification sample (5/5) and all six
  full signed local journeys (seven reported tests including the parent suite):
  `ABBY_CLINICAL_LIVE_EVAL=1 ABBY_CLINICAL_INTENT_MODEL=gpt-4o-mini
  node --env-file=/home/gust/code/abby/.env --test --test-concurrency=3
  test/voice/clinical-model-workflow-call.test.ts`. Earlier live runs exposed
  genuine cancellation-routing, booking-menu, outcome-question and
  rescheduling-phase errors; the current typed phase/schema and prompt changes
  were made in response to those traces. Exact `Yes` is handled by the trusted
  SAM gate rather than delegated to the model.

The first parallel signed run had two speech-wait timeouts. A diagnostic rerun
passed. The harness subsequently gained explicit processing fences for playback
receipts and final caller media, and that run passed too. This removes a real
fixture timing gap; it does not establish that every timing-related failure is
eliminated. Failure diagnostics contain statuses and counters, never private
caller text, codes or provider payloads.

## Remaining activation gates

The runnable standalone CLI does not enable patient-specific voice workflows.
Real email delivery remains deferred by the owner. Actual clinic permissions,
staff review approval, representative speech qualification and carrier calls
remain separate gates. The signed local transport is genuine, while mail,
Cliniko HTTP and speech transcription/synthesis in these journeys are synthetic.
The five-case live classification sample and six live model call journeys are
bounded evaluation evidence, not general reliability statistics or production
readiness. No actual patient or clinic record was used in model evaluation.
