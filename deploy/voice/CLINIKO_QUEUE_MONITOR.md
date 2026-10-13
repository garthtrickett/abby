# Approved independent Cliniko queue monitoring

The optional monitor connects current Cliniko queue health to the durable
aggregate alert receiver. It can run while the voice runner is stopped and
requires no Twilio number or email sender. It scans the clinic-approved full
recall type and sends only pending, overdue or unavailable counters.

The full type belongs to the approved account queue. Counts are not inferred
per-location filters or patient-specific task outcomes. Marked-recalled rows do
not count as pending; that flag does not prove a human read a request, called a
patient, performed a clinical mutation or resolved a disputed appointment.

## Current approval and recovery ownership

Two separate owner-provisioned files are required: the existing accepted
`OwnerFileStaffPolicy` process and an independent monitoring approval. Both use
the current location's trusted administrator directory. Capture and every use
recheck the exact source, approving membership, effective dates and enabled
status. Replacement, revocation and changed membership require a fresh process.

The monitor binds the current credential fingerprint, policy version, business,
recall type, clinic timezone, declared review owner/backup, polling cadence and
approved receiver/token fingerprints. Owner and backup must be distinct and
match the accepted staff process. The polling interval cannot exceed its review
cadence. These are approved declarations, not evidence that those humans are on
duty or have accepted a task. Actual recipient identity, paging, acknowledgment,
backup escalation and the clinic's operating rehearsal remain required.

Example monitoring record for review; disabled and unapproved:

```json
{
  "scope": { "tenantId": "demo", "clinicId": "clinic", "locationId": "main" },
  "revision": "queue-monitor-1",
  "approverRef": "clinic-admin",
  "approvedAt": "2026-10-13T00:00:00.000Z",
  "effectiveFrom": "2026-10-13T00:00:00.000Z",
  "effectiveUntil": "2026-10-14T00:00:00.000Z",
  "approved": false,
  "enabled": false,
  "policyVersion": "1",
  "businessId": "11",
  "recallTypeId": "7",
  "credentialFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "timeZone": "Australia/Sydney",
  "reviewOwnerRef": "duty-owner",
  "reviewBackupRef": "duty-backup",
  "pollEveryMinutes": 15,
  "pendingThreshold": 1,
  "overdueThreshold": 1,
  "alertUnavailable": true,
  "destinationFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "alertTokenFingerprint": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Thresholds range from 1 to 500. The unavailable alert is mandatory. Destination
and alert-token fingerprints are SHA-256 of their exact configured strings;
credential fingerprint uses the existing Cliniko credential helper. Keep raw
credentials outside the public approval files and Git. The canonical receiver
URL must use HTTPS without credentials, query or fragment. Explicit loopback
HTTP is restricted to trusted test ports; the stock CLI does not enable it.

## Complete scans and truthful outcomes

Every run uses the shared PostgreSQL Cliniko budget and existing standalone
privacy preflight. The bounded read validates every active page and never emits
partial counts. Missing pages, drift, malformed data, provider failure and rate
limits produce `queueUnavailable`, with no pending/overdue fields. If authority
is still current, a fixed unavailable counter can be sent. Revoked approval
instead stops reads/delivery and leaves infrastructure failure visible.

Completeness follows the provider's bounded page totals and ordering; it is not
an atomic account snapshot. Work can change between pages or after the scan.

Approval is checked before reads, after scanning and immediately before each
alert. A scan crossing the clinic's calendar-day boundary is unavailable rather
than reporting stale overdue counts. Receiver acceptance is counted only after
2xx. If approval changes after one accepted alert, the next is stopped and the
known accepted/attempted counts are retained. Lost/rejected receiver responses
remain `deliveryUnavailable`; one run never retries a POST. A later independent
poll can safely use the receiver's logical-alert deduplication.

There is a 180-second run deadline and a five-second delivery deadline. Abort
cannot revive late work or publish a healthy result. Only fixed aggregate
outcomes enter stdout; patient identifiers, notes, scope, credentials, receiver
keys and private approval paths are excluded. No appointment, recall or patient
mutation is performed.

## Configure and run

Use a separate owner-only environment file containing:

- `DATABASE_URL`, `ABBY_TENANT_ID`, `ABBY_CLINIC_ID`, `ABBY_LOCATION_ID`.
- `ABBY_CLINIKO_API_KEY`, `ABBY_CLINIKO_CONTACT_EMAIL`, `ABBY_CLINIKO_BUSINESS_ID`,
  `ABBY_CLINIKO_RECALL_TYPE_ID`, `ABBY_CLINIKO_RECALL_TIME_ZONE`.
- `ABBY_CLINIKO_QUEUE_POLICY_VERSION`, `ABBY_CLINIKO_QUEUE_POLL_MINUTES`.
- `ABBY_ADMIN_DIRECTORY_PATH`, `ABBY_CLINIKO_STAFF_APPROVAL_PATH`,
  `ABBY_CLINIKO_QUEUE_MONITOR_APPROVAL_PATH`.
- `ABBY_VOICE_ALERT_WEBHOOK_URL`, `ABBY_VOICE_ALERT_TOKEN_HEX`.
- Optional `ABBY_CLINIKO_BUDGET_USER_REF` for the existing shared-user budget.

Configure the upgraded receiver for `clinikoQueuePending`, `clinikoQueueOverdue`
and `clinikoQueueUnavailable` with matching thresholds, including unavailable=1.
Older receivers reject these new finite kinds. Existing voice-health keys remain
compatible, and the voice daily-counter sender still rejects queue-only kinds;
do not place them in its thresholds file.

After `npm run build:runtime`, run the separately compiled command under the
owner's supervisor:

```sh
node --env-file=/etc/abby/queue-monitor.env \
  dist/runtime/scripts/monitor-cliniko-queue.js
```

Exit 0 means a complete known scan and known transport results, including clear
thresholds with no send. Exit 2 means queue health is unavailable, even if the
unavailable alert was accepted. Exit 1 covers approval/delivery/other failure.
No exit code or inbox receipt establishes human acknowledgment.

## Independent timer

Render without installing or starting anything:

```sh
node scripts/render-cliniko-queue-monitor-systemd.mjs \
  --app-root /srv/abby --node-bin /usr/bin/node \
  --env-file /etc/abby/queue-monitor.env --service-user abby \
  --name abby-clinic-queue --out-dir /tmp/abby-queue-units \
  --poll-minutes 15
systemd-analyze verify /tmp/abby-queue-units/abby-clinic-queue.service \
  /tmp/abby-queue-units/abby-clinic-queue.timer
```

The renderer supports 1–60 minutes; a host can supply another supervisor for
longer declared intervals. The service runs the compiled monitor with private
configuration and binds the public cadence in its environment. That value takes
precedence over the env file, so runtime approval cannot describe a slower
cadence than the rendered value. See [Node's environment-file behavior](https://nodejs.org/download/release/v22.23.0/docs/api/cli.html#--env-filefile).
The UTC persistent calendar timer is independent of the voice runner. It does
not start overlapping copies of an active service or guarantee a precise review
time. See [systemd's timer semantics](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml).

Inspect the units and actual receiver path before the owner installs them.
Monitor failed units and missing/late polls using the owner's independent
infrastructure channel. A fresh poll discovers current Cliniko work; it does not
restore lost transient caller authority or replay a clinical action.

## Local evidence and remaining work

Thirteen patient-free monitor checks passed with zero skips, including actual
provider reads/shared budget, a real receiver, known and unavailable compiled
monitor processes, current duty/cadence/receiver bindings, mid-read revocation,
partial acceptance, lost result, abort and concurrent-run denial. Database,
backup, output and inbox canary checks exclude patient details. Renderer and
existing alert-timer checks also passed; `systemd-analyze verify` validated the
generated queue units without installation.

This completes local monitoring transport and declared-owner binding. It does
not prove a deployed timer, recipient, human paging/acknowledgment/escalation,
accepted clinic process, live permission source or production clinical activation.
The full thirteen-gap objective remains active.

The final whole-source typecheck, compiled build and migrated regression passed
36 checks with zero failures or skips. The regression includes queue monitoring,
the receiver/inbox and actual restart tests, existing operational counters and
sender, Cliniko queue report/pulse, both timer renderers and the manifest:

```sh
npm run typecheck && npm run build:voice-tests
bash scripts/with-postgres.sh bash -c '
  npm run db:migrate &&
  node --test --test-concurrency=4 \
    test/cliniko/queue-monitor.test.ts \
    test/voice/operational-alert-inbox.test.ts \
    test/voice/operational-alert-receiver-postgres.test.ts \
    test/storage/postgres-operational-counters.test.ts \
    test/cliniko/recall-queue-report-postgres.test.ts \
    test/cliniko/recall-queue-pulse.test.ts \
    test/contract/scenario-manifest.test.ts \
    test/deploy/voice-ops-alert-systemd.test.mjs \
    test/deploy/cliniko-queue-monitor-systemd.test.mjs
'
```

Tracked job `Abby approved queue monitor final type compiled and delivery regression October 13`
completed exit 0; log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791868426992.log`.
An earlier compiled gate rejected widened counter-name string types; declaring
the two finite labels as literals restored the intended union without changing
runtime behavior or weakening assertions. Manifest 1.152 supplements E2E-220,
retains 347 scenarios and planned full-call evidence, and still needs version
reconciliation with independent unmerged PRs 453/454.
