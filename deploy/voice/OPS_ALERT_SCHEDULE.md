# Independent aggregate alert schedule

The sender reads one configured clinic/location's seven retained UTC daily counter buckets. Every 15 minutes it POSTs each crossed threshold to an owner-controlled HTTPS receiver. A systemd timer can run it while the voice runner is stopped. After a timer outage it retries crossings still within the seven-day window; older days are gone. Every run can resend the same crossing, so the receiver **must** deduplicate the `Idempotency-Key` header (also present as `alertKey` in the JSON body) for at least the full seven-day window. The optional [durable receiver](OPS_ALERT_RECEIVER.md) now proves local authenticated storage and restart deduplication. A 2xx confirms receiver acceptance only. Human paging, clinic recipient identity and acknowledgment require a separately proven receiver workflow.

Create one owner-only environment file per clinic/location. It must be readable by the selected service user, have no group or other permissions, and remain outside Git. Configure `DATABASE_URL`, `ABBY_TENANT_ID`, `ABBY_CLINIC_ID`, `ABBY_LOCATION_ID`, `ABBY_VOICE_OPS_THRESHOLDS_JSON`, `ABBY_VOICE_ALERT_WEBHOOK_URL`, and `ABBY_VOICE_ALERT_TOKEN_HEX`. The webhook URL must be HTTPS without URL credentials, query or fragment. The token is a separate 64-character hex value for the receiver; keep it out of shell arguments, unit text and logs. The database user needs scoped daily-counter read and expiry-delete access. Use an HTTPS receiver that verifies the bearer token, persists deduplication keys and dispatches to the intended clinic operators. Configure its acknowledgment process before treating this as operational paging.

Render system units using paths and the service identity only:

```sh
node scripts/render-voice-ops-alert-systemd.mjs \
  --app-root /srv/abby \
  --node-bin /usr/bin/node \
  --env-file /etc/abby/ops-alert-clinic.env \
  --service-user abby \
  --name abby-ops-alert-clinic \
  --out-dir /tmp/abby-ops-units
systemd-analyze verify /tmp/abby-ops-units/abby-ops-alert-clinic.service /tmp/abby-ops-units/abby-ops-alert-clinic.timer
```

Inspect the rendered units, then install both under `/etc/systemd/system` with mode `0644`, run `systemctl daemon-reload`, and `systemctl enable --now abby-ops-alert-clinic.timer`. Run `systemctl start abby-ops-alert-clinic.service` once to test actual sender-to-receiver delivery, and inspect `systemctl status` and receiver-side acceptance/deduplication. The service's stdout contains only the UTC date and accepted POST count; failure stderr is fixed and omits endpoint and scope. Check `systemctl list-timers abby-ops-alert-clinic.timer` and monitor service failures externally. Generate a distinct unit name and env file for every clinic/location; never combine scopes in one sender process.

The generated units use a one-shot service, a 15-minute timer with persistent wake-up, a 30-second service timeout, owner-only process umask and restricted filesystem writes. The renderer refuses unsafe paths, a non-private env file and an existing output unit. It does not install or enable anything. `node --test test/deploy/voice-ops-alert-systemd.test.mjs` checks rendering; E2E-220 exercises same-day and prior-day PostgreSQL-to-receiver delivery. These are local proofs, not evidence that a production receiver, clinic recipient or timer is active.
