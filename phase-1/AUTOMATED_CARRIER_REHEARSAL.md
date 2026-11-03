# Automated Twilio caller rehearsal

This test caller replaces the reference application's Vapi patient-bot role for
one restricted audio dialogue. It uses Twilio `Say` and speech `Gather`, calls the
isolated Abby test number, hears the greeting, says hello/blue/green, checks the
fixed replies and hangs up. It has no clinic, patient, booking or payment tools.
No Vapi account, extra LLM conversation engine or local audio files are required.

## What a pass establishes

`carrierDialoguePassed` requires all four speech callbacks from the exact
API-created outbound leg, matched in order, followed by an independently fetched
Twilio `completed` state for that same leg. Call completion alone cannot pass.
Transcription is transient; reports contain only fixed step names and statuses.
The provider processes speech and retains its own metadata under its account
settings; `record:false` prevents the harness requesting a recording.

The report explicitly leaves `interruption:notRun`, `fallbackRinging:notRun`,
`normalHangupNoFallback:unverified` and `clinicalAcceptance:false`. This first
script neither proves complete receptionist workflows nor replaces acoustic
qualification. In particular, the current fixed hello/colour expectations target
our restricted diagnostic greeting, not the default clinical server.

## Configuration and operation

Supply these through an owner-only private environment file, outside Git:

- `ABBY_VOICE_TEST_MODE=1`
- `ABBY_TWILIO_ACCOUNT_SID`, `ABBY_TWILIO_AUTH_TOKEN`
- `ABBY_TWILIO_TEST_NUMBER`: the isolated Abby destination
- `ABBY_TWILIO_TEST_CALLER_NUMBER`: a different Twilio-owned or verified caller ID,
  also allowlisted by the Abby test endpoint
- `ABBY_REHEARSAL_CALLBACK_BASE`: a dedicated public HTTPS origin forwarding to
  this caller's loopback listener; it must differ operationally from Abby's
  receptionist endpoint (do not repoint the receptionist tunnel)
- `ABBY_REHEARSAL_PORT`: the dedicated loopback port, default3121

The current clinic test endpoint and its approved caller remain the operator's
responsibility. Do not buy a number, request caller-ID verification, change the
allowlist or target a clinic on the strength of this script. Preflight reads
caller eligibility without making a call. Execute also verifies that the public callback health response matches this exact run before dialling. It does not certify the target's
configuration, tunnel reachability or clinic permissions.

```sh
npm run voice:rehearse-carrier -- --dry-run
npm run voice:rehearse-carrier -- --preflight
npm run voice:rehearse-carrier -- --execute /absolute/private/new-run.json
```

Use the machine's tracked `work run`/`work wait` and bounded escaped scope for
an actual run. The callback listener binds only127.0.0.1. The exact public origin
is used for Twilio signature validation; a proxy must preserve method, path,
body and signature. It serves no transcripts or private results over HTTP.

`--execute` creates a mode600 journal with exclusive creation: an existing path
refuses the run before dialling. It journals intent before its one physical
create attempt; SDK auto-retry is disabled. An unacknowledged create stays
`launchUnknown` and needs reconciliation, never a replacement call. An
acknowledged leg is polled by exact SID, capped at180 connected seconds and a
210-second observation window. Failed expectations request hangup, and deadline
or interruption attempts cleanup of that exact leg. Unknown terminal state
cannot pass. A restart does not replay a phone call.

Callbacks require the exact account, SID, direction, numbers, run, step and
signature. Identical retries return the same TwiML; conflicting/out-of-order
callbacks cannot advance. Only fixed public utterances can be emitted. Nothing
from recognized speech is interpolated into TwiML or written to the journal.

## Reference and next cases

The owner-supplied reference `server/src/testing/e2eVoice/patientBot.ts` launches
an AI patient through Vapi, while `run.ts` waits for its terminal and judges local
post-call events. This harness copies the independent caller/scenario pattern,
using direct Twilio commands and exact acknowledged-call matching instead of
latest-call/time-window selection. The test caller can gain richer scripted or
LLM scenarios independently of Abby's production voice runtime.

Next cases need their own evidence: intentional overlap with measured stale
playback rejection; keypad9/failure injection with provider-observed fallback
ringing; and a normal hangup with no unexpected fallback leg. Twilio can emit
DTMF with `Play digits` outside `Gather`; merely issuing that command does not
prove ringing. None of those cases is silently counted as passed here.

The optional `voice:rehearse-carrier-probe` command prepares separate
`dialogue`, `interruption` and `fallback` scenarios for this restricted target.
The dialogue case requires the target's exact three turns and four completed
playbacks, a completed inbound leg and a complete empty child-leg page. This
qualifies normal hangup without an unexpected fallback leg on that call. Its
interruption case requires the target's exact call statistics to show two
recognized turns, two completed playbacks, one interruption and one acknowledged
clear. Its fallback case requires a signed `ringing` callback for the exact
child leg and a complete, independent Twilio readback of that child under the
target call. Both require the exact caller to complete, a fresh same-run target
report and the matching inbound leg. These checks are code paths, not a claim
that either real-carrier case has passed. They do not qualify audio quality,
ordinary clinic conversations or staff acceptance.

For a fallback probe, configure the restricted target's
`ABBY_REHEARSAL_FALLBACK_CALLBACK_URL` to a fresh HTTPS
`/fallback-ringing/<32 lowercase hex>` route on the *caller's* dedicated public
origin before starting the target. That route must forward unchanged to the
caller loopback listener. Set `ABBY_TWILIO_FALLBACK_NUMBER` to a third, distinct
approved number. The runner reuses the callback token, which binds the target's
status events to that one test window. Use new absolute private journal and
target-report paths for each execution:

```sh
npm run voice:rehearse-carrier-probe -- --dry-run dialogue
npm run voice:rehearse-carrier-probe -- --execute dialogue /private/new-journal.json /private/target-report.json
npm run voice:rehearse-carrier-probe -- --dry-run interruption
npm run voice:rehearse-carrier-probe -- --preflight interruption
npm run voice:rehearse-carrier-probe -- --execute interruption /private/new-journal.json /private/target-report.json
npm run voice:rehearse-carrier-probe -- --execute fallback /private/new-journal.json /private/target-report.json
```

The one-create intent journal, no-retry rule and separate isolated target setup
still apply. A missing callback, partial child page, mismatched parent or stale
target report yields `unverified`, never an inferred pass. The fixed 25-second
lead-in and three-second interruption cadence may need measured tuning after a
real call; do not count a synthetic script as carrier proof.

For a single temporary public origin, the test-only
`voice:serve-rehearsal-gateway -- --serve` command routes the target's signed
HTTP/WebSocket paths to port 3120 and this caller's exact health/callback paths
to port 3121. Expose only its loopback port 3119 through a fresh tunnel; see
the [restricted target setup](../phase-2/TWILIO_REHEARSAL_TARGET.md#one-temporary-public-tunnel-for-target-and-caller).
This does not start either listener, change Twilio settings or place a call.

Primary protocol references: [Calls API](https://www.twilio.com/docs/voice/api/call-resource),
[Gather](https://www.twilio.com/docs/voice/twiml/gather),
[Say](https://www.twilio.com/docs/voice/twiml/say),
[Play digits](https://www.twilio.com/docs/voice/twiml/play#digits).

Cancellation is rechecked after caller eligibility and after writing launch intent,
before any physical call is created. A cancellation received while reading the
exact call's terminal status invalidates the run and cleans up that owned leg;
a matched dialogue cannot become a passing result after cancellation.
