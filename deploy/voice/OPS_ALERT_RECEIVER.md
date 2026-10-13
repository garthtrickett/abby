# Durable operational alert receiver

The optional receiver completes the local sender-to-inbox path for aggregate
voice health alerts. It authenticates one configured clinic/location, accepts
only configured thresholds and seven retained UTC days, and stores one receipt
per day/counter/threshold. It needs no Twilio number or email account.

It now also accepts the three finite counters from the separately approved
[Cliniko queue monitor](CLINIKO_QUEUE_MONITOR.md). Existing voice daily-counter
configuration remains separate; queue counters do not become runtime database
columns or ordinary caller commands.

A 202 means the receiver durably stored that logical alert. It does not mean an
operator was paged, read it, accepted a staff request or completed recovery.
Clinic-approved paging, duty and backup ownership, acknowledgment and escalation
remain deployment requirements. Patient-specific request details remain in the
approved Cliniko queue and never enter this inbox.

## Provision and run

Use a dedicated canonical absolute directory on a local Linux filesystem, owned
by the receiver's Unix user with mode 0700. Keep it outside Git and any public
web root. The module creates a separate private subdirectory for the configured
clinic/location. It requires private regular receipt files and refuses symlinks,
unexpected filenames, malformed records and unsafe ownership or permissions.

An owner-only environment file contains:

- `ABBY_TENANT_ID`, `ABBY_CLINIC_ID`, `ABBY_LOCATION_ID`: exact sender scope.
- `ABBY_VOICE_ALERT_TOKEN_HEX`: the same separately provisioned bearer secret as
  the sender, including its spelling/case. Never place it in command arguments,
  unit text, logs or an approval record.
- `ABBY_VOICE_OPS_THRESHOLDS_JSON`: the approved fixed counter thresholds. A
  threshold absent here cannot be submitted. Match the sender configuration.
- `ABBY_VOICE_ALERT_INBOX_DIRECTORY`: the existing private canonical directory.
- `ABBY_VOICE_ALERT_RECEIVER_PORT`: local port, default 9041. Port 0 is supported
  for an isolated rehearsal and selects an ephemeral port.

Configuration is captured at startup. Restart the receiver after changing the
token, scope or thresholds; changing an environment file does not revoke a
running process's captured configuration.

Build with `npm run build:runtime`. Start the receiver under the owner's process
supervisor using the private environment file:

```sh
node --env-file=/etc/abby/ops-alert-clinic.env \
  dist/runtime/scripts/serve-voice-operational-alert-receiver.js
```

It binds only to `127.0.0.1`. Configure an owner-managed HTTPS proxy to forward
`POST /voice-operational-alerts` to that listener, then set the sender's
`ABBY_VOICE_ALERT_WEBHOOK_URL` to the HTTPS route. The public sender continues to
refuse plaintext destinations, URL credentials, queries, fragments and
redirects. The loopback HTTP exception belongs only to explicit tests.

The receiver starts only after checking storage. Readiness stdout contains only
the chosen local port; failures use fixed stderr without configuration, token or
payload. SIGTERM/SIGINT close ingress, abort active requests and await owned
work. HTTP bodies are limited to 1 KiB; requests expire after five seconds;
connections and simultaneous requests are bounded. There is no remote inbox
reader or human acknowledgment endpoint.

## Acceptance and recovery

The receiver checks the bearer secret, exact payload schema, header/body key
agreement, configured threshold and the sender's clinic/date/counter/threshold
HMAC. Wrong scope, extra fields, invalid counts, future or expired days and
changed thresholds cannot create a receipt. Credentials and keys are never
written to the inbox.

Each receipt contains only `date`, `kind`, `count` and `threshold`. It records the
first accepted crossing count, not current health. Later higher counts for the
same logical alert are accepted as duplicates and do not overwrite it. Refresh
current health using the existing daily-counter report.

The module writes and syncs a private temporary file, atomically links it into
the unique receipt name without replacing an existing receipt, and syncs the
directory before acceptance. Separate receiver processes share the same logical
receipt. A lost HTTP reply or receiver crash after storage leaves the sender
uncertain; the independent timer can retry safely against that receipt. This
does not authorize replaying a clinical mutation or staff request.

These file and listener operations use [Node's filesystem interface](https://nodejs.org/download/release/v22.23.0/docs/api/fs.html)
and [HTTP interface](https://nodejs.org/download/release/v22.23.0/docs/api/http.html).
The local SIGKILL test proves process recovery after acceptance; it does not
prove power-loss durability on every filesystem or storage device.

## Operator inspection and retention

Inspect the scoped aggregate inbox with the same private configuration:

```sh
node --env-file=/etc/abby/ops-alert-clinic.env \
  dist/runtime/scripts/read-voice-operational-alert-inbox.js
```

The output is a bounded aggregate list. A fresh process can read it after the
receiver dies. Reads and submissions prune this scope's receipts older than
seven UTC days. Other clinic directories are untouched. This module's private
abandoned temporary files can be removed after 24 hours; unknown files and
corrupt receipts require explicit operator investigation and are never silently
deleted. Scans are bounded at 512 entries and fail as a whole instead of returning
partial or reassuring empty results.

Run the existing independent [sender timer](OPS_ALERT_SCHEDULE.md). Monitor both
sender failures and receiver/process/storage failures through the owner's
separate infrastructure channel. Local receiver storage is one transport stage;
record the actual operator recipient, duty/backup ownership and escalation
process before relying on it for operational paging.

## Local qualification

Patient-free tests use actual private files, HTTP sockets, PostgreSQL daily
counters, separately compiled receiver and reader processes, and a proxy that
drops the real sender connection after upstream acceptance. They kill the
receiver with SIGKILL, restart it and prove catch-up creates no duplicate
receipts. Tests cover concurrent receivers, scope isolation, malformed payloads,
unsafe/corrupt storage, retained/expired dates, bounded incomplete HTTP bodies,
and canary exclusion in database, backup, files and process output.

`test/voice/operational-alert-inbox.test.ts` and
`test/voice/operational-alert-receiver-postgres.test.ts` supplement E2E-220.
No real recipient, external HTTPS route, human acknowledgment, timer installation
or production clinical activation is established by these local tests.

The current source passed `npm run typecheck` and `npm run build:voice-tests`.
The complete migrated regression passed 22 checks, zero failures or skips:

```sh
bash scripts/with-postgres.sh bash -c '
  npm run db:migrate &&
  node --test --test-concurrency=4 \
    test/voice/operational-alert-inbox.test.ts \
    test/voice/operational-alert-receiver-postgres.test.ts \
    test/storage/postgres-operational-counters.test.ts \
    test/cliniko/recall-queue-report-postgres.test.ts \
    test/cliniko/recall-queue-pulse.test.ts \
    test/contract/scenario-manifest.test.ts \
    test/deploy/voice-ops-alert-systemd.test.mjs
'
```

Tracked job `Abby operational receiver migrated delivery regression October 13`
completed exit 0; log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791866064646.log`.
Typecheck/build completed in the preceding job, log
`/home/gust/paseo/paseo-home/work/logs/4590eee3-1791865826612.log`.
That initial regression failed seven existing storage cases because its command
omitted migration of the shared disposable database. The corrected command ran
the existing migrations without implementation changes, altered deadlines,
worker reductions or assertion changes.

Manifest 1.151 retains 347 scenarios and planned full-call evidence. Independent
unmerged PRs 453/454 carry versions 1.147–1.150 and need reconciliation on rebase.
The full thirteen-gap objective remains active; the receiver does not close the
remaining staff-process, speech, catalogue, class, payment or campaign work.
