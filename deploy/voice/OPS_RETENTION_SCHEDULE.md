# Independent daily aggregate retention

The standalone runner deletes expired daily aggregate rows at startup and every six hours while it runs. For cleanup when all voice runners are stopped, deploy the separate `npm run voice:ops:prune` command as a systemd one-shot timer. It deletes expired daily rows across clinic scopes without emitting a clinic, caller, patient, call or credential value. Lifetime aggregate totals are unaffected.

Create an owner-only environment file containing `DATABASE_URL` for a database role authorized to delete expired `clinic_operational_daily_counts` rows across all clinics. The file must be readable by the service user, have no group or other permissions, and stay outside Git. The generated service does not contain the database URL.

Render system units using paths and the service identity only:

```sh
node scripts/render-voice-ops-retention-systemd.mjs \
  --app-root /srv/abby \
  --node-bin /usr/bin/node \
  --env-file /etc/abby/ops-retention.env \
  --service-user abby \
  --name abby-ops-retention \
  --out-dir /tmp/abby-retention-units
systemd-analyze verify /tmp/abby-retention-units/abby-ops-retention.service /tmp/abby-retention-units/abby-ops-retention.timer
```

Inspect the rendered units, install both under `/etc/systemd/system` with mode `0644`, run `systemctl daemon-reload`, then `systemctl enable --now abby-ops-retention.timer`. Run `systemctl start abby-ops-retention.service` once and check its exit status; `systemctl list-timers abby-ops-retention.timer` shows the next run. Monitor failed service runs externally. One global timer suffices for all clinics in the database; do not create one per clinic.

The timer runs at 00:00 UTC with `AccuracySec=1s` and `Persistent=true`. A normal run removes dates outside the seven-day view shortly after midnight. A missed run executes when the timer next starts. Deletion has no absolute deadline while the host, database, or timer is unavailable; provision and monitor the timer in any deployment that requires one. The renderer only creates unit files and does not install or activate them. `E2E-218` proves the one-shot PostgreSQL cleanup and preserved lifetime totals; the renderer test and `systemd-analyze verify` prove only the unit contract.
