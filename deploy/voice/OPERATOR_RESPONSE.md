# Authenticated operational response

This optional companion application lets an approved owner or backup explicitly
accept responsibility for an aggregate infrastructure or queue alert. It needs
no telephone number. It reuses the host's current authenticated identity; the
included magic-link composition needs a provisioned sign-in delivery channel.
Local tests deliver synthetic sign-in messages only.

The alert receiver's 202, an authenticated operator's acknowledgment, and a
completed patient request are distinct outcomes. This application implements
the second outcome. Patient-specific work remains in Cliniko. It does not page
a phone, send a clinical message, or resolve a Cliniko task.

## Provisioning

Provision a separate canonical absolute directory, owned by the application
user with mode 0700, for responsibility state. Keep it outside the receipt root,
Git and any web root. Both the receipt inbox and response workflow must have
the same tenant, clinic and location. The host supplies the current scoped admin
directory and an owner-only approval file with exactly these fields:

```json
{
  "scope": { "tenantId": "example", "clinicId": "clinic", "locationId": "main" },
  "revision": "response-1",
  "approverRef": "clinic-owner",
  "approvedAt": "2026-10-13T00:00:00.000Z",
  "effectiveFrom": "2026-10-13T00:00:00.000Z",
  "effectiveUntil": "2026-10-30T00:00:00.000Z",
  "approved": true,
  "enabled": true,
  "channel": "authenticatedOperatorInbox",
  "ownerRef": "clinic-owner",
  "backupRef": "clinic-backup",
  "escalateAfterMinutes": 10,
  "responsibilityMinutes": 15,
  "alertKinds": ["voiceFailure", "clinikoQueueOverdue", "clinikoQueueUnavailable"]
}
```

These are synthetic examples, not activated clinic authority. The approver must
be a current clinic administrator. Owner and backup must be distinct current
approved accounts in the exact scope. Durations are whole minutes from 1 to
1440; kinds are unique members of the existing finite aggregate alert codes.
Changing the approval file or approving membership invalidates a running
workflow. Restart with the newly approved source. Removed backup membership
denies the workflow rather than leaving an unusable backup silently assigned.

## Host composition

Build with `npm run build:runtime` and `npm run build:sign-in`. The compiled host
can construct `OperatorAlertWorkflow.create({scope, inbox, stateDirectory,
approvalPath, directory})`, check its typed result, and compose either:

- `createOperatorAlertHttp(identity, workflow)`: the trusted embedding host
  supplies the canonical HTTPS origin and resolves its current signed-in actor.
- `createOperatorAlertMagicLink(identity, workflow, signInBundlePath)`: reuses
  Abby's `MagicLinkIdentity`, durable session store, directory and sign-in
  delivery port. The companion application's root is its alert page.

Serve the resulting `handle` behind the approved HTTPS host and call `close`
during shutdown. Only `GET /`, `GET /operator-alerts`, `GET /api/operator-alerts`
and `POST /api/operator-alerts/acknowledge` belong to this application; the
magic-link composition additionally owns the existing sign-in routes. It is a
companion host, not an automatically installed route on every clinic dashboard.
The existing receiver CLI remains receipt-only.

Pass this same workflow as the optional third argument to
`startVoiceOperationalAlertReceiver(inbox, port, workflow)` to observe alerts
when they arrive. Receiver startup validates authority and state. With that
option, 202 means both receipt storage and approved workflow observation
succeeded; it still does not imply human acknowledgment. A failed observation
returns 503 even if receipt storage already succeeded. The independent sender
may retry that immutable receipt without duplicating it.

Keep an independent sender schedule active and monitor both applications outside
their own process. Reads and receiver retries discover unobserved retained
receipts after recovery. Backup assignment is calculated from current time on
each read or action; the page refreshes every 30 seconds. This is an in-app
notification workflow. It does not deliver external paging when nobody opens
the page, or detect that both applications have stopped.

The optional [selected queue-work diagnostic](../../phase-2/QUEUE_WORK_FRESHNESS.md) reads the accepted local systemd queue profile without loading its environment file or retaining timestamps. It distinguishes actual recent completion from defaults, new pending/running work, misses and failures. Its local source/OS fixtures do not install a monitor or qualify a real clinic. Bind the actual release, local manager, profile and cadence separately. Keep the external sender/receiver/host and human-responsibility checks above.

## Responsibility and recovery

The first approved workflow observation starts the escalation clock. It is an
operator observation time, not a patient event time or the original sender's
delivery time. Previously retained alerts discovered at activation or recovery
start that clock when first observed.

Before the escalation deadline, only the approved owner can accept
responsibility. An unacknowledged alert becomes the backup's responsibility at
the deadline. An accepted responsibility period expires after the approved
duration and never extends beyond the approval's effective end. Expired or
invalidated responsibility becomes the backup's responsibility. The backup can
accept another bounded period. A membership or policy change cannot preserve
an acknowledgment made under the previous authority.

The page shows the fixed alert code, retained day, first accepted count and
threshold, current assignment and responsibility deadline. It does not show
operator emails, internal references, sessions or sender keys. The button
**I’m handling this** submits only the displayed alert and its expected version.
Identity comes from the authenticated host session, never that body or the
alert sender's bearer credential. Cross-origin writes, wrong hosts, extra
fields and oversized bodies cannot acknowledge. Requests expire after five
seconds; concurrent handler work is bounded at 32 requests.

State publication has one winner across processes. A lost reply requires
refreshing the authoritative view. Repeating the same actor's already active
acknowledgment reports it as known without extending its period. A stale
version or changed assignment cannot overwrite a different acceptance. No
action changes the immutable transport receipt, patient request or clinical
mutation.

Separate owner-only state files contain aggregate alert fields, version,
approval/membership fingerprints, operator reference and operator
observation/action times. They contain no patient, call or clinical-action
identifiers, free text, email, session or credential. Immutable version records
are fsynced before publication and survive application reconstruction. Retention
removes only this scope's expired seven-day governance, and refuses unknown or
corrupt records. Own abandoned temporary files may be removed after 24 hours.
Scans are bounded at 512 alerts and 16,385 versions per alert; exhaustion is
unavailable, not a successful acknowledgment.

## Agent-operated demo backup observation, 25 October 2026

The owner designated another agent as the demo backup. Using browser-drive,
the agent signed distinct synthetic primary and backup accounts into the
unchanged production TLS, identity, receiver, workflow and HTTP application.
The primary never acknowledged. After 60.227 actual monotonic seconds under
the configured one-minute escalation, the backup explicitly clicked the
acknowledgment button. No workflow clock was injected or accelerated.

The actual server committed the acknowledgment before its response was
deliberately dropped at the browser boundary. The page showed uncertainty,
then refreshed the known accepted state. Retrying that acknowledgment and
the original receiver request, and reconstructing the application/workflow,
retained version 1 and the original two-minute responsibility deadline.
Early backup and late primary actions, actor-body spoofing, foreign origin,
wrong current actor, removed backup membership and withdrawn approving
administrator role were denied.

Tracked work `1792934942902` completed with exit 0 in about 70 seconds. The
512 MiB/one-CPU/zero-swap scope closed. The additional 512 MiB browser allowance
was admission headroom for the existing shared browser, not a whole-browser
hard cap. Both owned browser contexts and all owned listeners closed; the
shared default context stayed untouched. All 744 runtime artifacts, owned
sources and 48 frozen proof pins remained exact. A parent audit independently
checked the raw ten-step log, durable versions, three screenshots, hashes and
current listener/browser cleanup.

Private aggregate provenance is
`abby-agent-backup-rehearsal-20261025/parent-independent-audit-v1.json` under
the existing private state home; result SHA256
`cf6a57e3eaf9e60c43580d6c8f8988366299c8c23434590f216ab20bb4a13c19`.
The synthetic in-memory sign-in store and captured local inbox were retained
across object reconstruction. Full process/session-database recovery,
external inbox delivery and human clinic sign-off were not tested by this run.
It made no patient, Cliniko, Stripe or carrier request and activated nothing.
Earlier PostgreSQL and process evidence below retains its separate scope.

## Qualification and remaining deployment evidence

`test/voice/operator-alert-workflow.test.ts` exercises actual private storage,
receiver observation, concurrent acceptance, restart reconstruction, expiry,
current authority, retention and corrupt data. `operator-alert-http.test.ts`
covers exact bodies and the real incomplete-request deadline. Independently
compiled processes race one acknowledgment and a fresh process recovers it. The browser
journey uses actual local TLS, PostgreSQL sessions, delivered synthetic
sign-in messages, separate owner/backup browser sessions, acknowledgment,
application reconstruction, expiry and authentication/origin/host rejection.

These tests establish the local workflow. They do not establish real clinic
operator availability, an installed external notification channel, a live
recipient witness, power-loss behavior for every filesystem, or clinical
readiness. The full thirteen-gap objective remains active.

The full local gate passed typecheck, runtime/voice-test compilation, the
sign-in bundle, 44 migrated monitoring/delivery checks and one browser journey,
with no failures or skips. Tracked job
`Abby operator responsibility final compiled delivery and browser qualification October 13`,
exit 0, log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791871305263.log`.

The final retention correction and normal text-gate build prerequisite passed
fresh typecheck/compilation, 17 focused checks and the same browser journey,
with no failures or skips. Exact final command:

```sh
npm run typecheck
npm run build:voice-tests
node --test \
  test/voice/operator-alert-process.test.ts \
  test/voice/operator-alert-workflow.test.ts \
  test/voice/operator-alert-http.test.ts \
  test/voice/operational-alert-inbox.test.ts \
  test/contract/scenario-manifest.test.ts
npx playwright test test/browser/operator-alert-responsibility.spec.ts --workers=1
git diff --check
```

Tracked job `Abby operator retention recovery final gate October 13`, exit 0,
log `/home/gust/paseo/paseo-home/work/logs/4590eee3-1791871593328.log`.
The normal `test:text` command now builds the compiled fixtures first, so the
process test does not depend on stale local artifacts. Manifest 1.153 adds
E2E-220 evidence and preserves 347 scenarios and planned full-call qualification.

Earlier failures exposed an order-sensitive comparison of JSON fields and an
HTTP fixture whose fetch request did not forward the approved public Host to
loopback. Alert comparison now uses the canonical field tuple; the HTTP fixture
uses actual Node HTTP requests with the approved proxy Host and demonstrates
both invalid-body refusal and a successful explicit acknowledgment on the same
path. The five-second deadline, authority checks and browser assertions were
preserved. Oversized bodies may be rejected or disconnected; neither outcome
can acknowledge.
