# Restricted public Twilio rehearsal target

The optional target exercises the real signed HTTP/WebSocket, media decoder,
endpointing, streaming playback and interruption owners using fixed public
phrases. It accepts one explicitly configured caller on one test number, at most
six distinct sessions in a one-hour CLI window. Each call retains the existing
180-second bound. General `/readyz` admission stays closed.

The target provides greeting, hello/blue/green replies, an interruptible count,
caller hangup and digit-nine fallback closure. Other speech receives a fixed test
response. Transcription has no clinical authority; there is no clinic host,
patient lookup, booking, payment or outbound launch interface in this composition.

## Start an explicitly authorized test window

Build the serving fixtures with `npm run build:voice-tests`. Supply a private
environment file containing:

- `ABBY_VOICE_TEST_MODE=1`;
- `ABBY_TWILIO_ACCOUNT_SID`, `ABBY_TWILIO_AUTH_TOKEN` and a fresh independent
  64-hex-character `ABBY_TWILIO_BINDING_KEY_HEX`;
- three distinct approved international numbers: `ABBY_TWILIO_TEST_NUMBER`,
  `ABBY_TWILIO_TEST_CALLER_NUMBER`, `ABBY_TWILIO_FALLBACK_NUMBER`;
- the fresh temporary HTTPS `ABBY_TWILIO_PUBLIC_WEBHOOK_URL` and WSS
  `ABBY_TWILIO_PUBLIC_STREAM_URL`;
- an isolated `DATABASE_URL` for the existing PostgreSQL active-call claim owner;
- project-scoped `ABBY_DEEPGRAM_API_KEY` and `ABBY_OPENAI_API_KEY`.

The loopback port defaults to 3120 and can be set with
`ABBY_REHEARSAL_TARGET_PORT`; zero selects an ephemeral port recorded in the
private report. With environment variables already injected, use
`npm run voice:serve-rehearsal -- --serve /private/new-report.json`.
Node can load the private file directly:

```sh
node --env-file=/private/rehearsal.env \
  dist/runtime/scripts/serve-twilio-rehearsal.js --serve /private/new-report.json
```

Use the host's existing tracked-work and resource-admission procedure for a real
window. Keep the target, database, tunnel and caller isolated from other work.
Configure the already approved test number's provider routes through the existing
authorized setup procedure. Starting this command does not change provider
settings or place a call.

The report path must be new; restarting against an existing report refuses.
Reports contain a fresh run ID, phase, expiry, aggregate counts and the current
test call's opaque provider ID and fixed classifications. Speech and audio are
transient. A missing or stale report supplies no passing evidence. Shutdown closes
admission and waits for bounded media cleanup, in-flight ownership claims and
their database lease releases. A release failure prevents a successful `stopped`
report. Repeated shutdown requests share the same completion promise.

For signed fallback ringing events, the optional
`ABBY_REHEARSAL_FALLBACK_CALLBACK_URL` must be an HTTPS URL ending in
`/fallback-ringing/<32 lowercase hex characters>`, without credentials, a query
or a fragment. The caller must separately authenticate exact parent/child events;
requesting fallback or observing a completed leg alone cannot prove ringing.

### One temporary public tunnel for target and caller

The optional `voice:serve-rehearsal-gateway` command binds only to loopback
(default port 3119) and routes the exact signed target webhook and media socket
to the target listener (default 3120). It routes only the caller's `/healthz`,
`/voice-rehearsal/<run>/<step>` and `/fallback-ringing/<run>` requests, plus the
test-only signed `/voice-rehearsal-media/<run>/` socket, to the
separate caller listener (default 3121). Other routes return 404. Its window is
bounded to one hour and shutdown closes proxied media sockets. It has no clinic
host, speech adapter, outbound dialler or provider-setting access.
Its public health token is withheld unless the target's local health endpoint
also answers, so a missing target cannot pass the caller's pre-dial check.

With both local listeners and gateway running under the host's tracked-work and
admission procedure, expose the gateway port through **one new** temporary
HTTPS/WSS tunnel. Set the target's webhook URL to `<base>/twilio/inbound`, its
stream URL to `wss://<host>/twilio/media/`, the caller's callback base to
`<base>` and the fallback callback to
`<base>/fallback-ringing/<fresh-32-hex-token>`. Check the target locally and
the caller's public health token before placing a call. Preserve the existing
Twilio number configuration for restoration; change its webhook only after the
new isolated target is listening. Never reuse an old URL merely because it is
present in a private environment file.

## Verification and remaining work

The local target tests use injected speech adapters and real loopback signed
HTTP/WebSocket traffic. They exercise the idle quiet burst, greeting/replies,
clear-fence interruption, private-canary handling, caller stop, digit-nine
closure, expired admission, six-session exhaustion and reporting failure. Controlled
shutdown cases hold media cleanup and lease release open, including a late claim,
and verify that completion cannot be reported early or after a release failure.

The committed `voice:rehearse-carrier` caller still qualifies its separate
scripted dialogue. Portable interruption/fallback caller orchestration, repeated
real-carrier qualification on one complete head, acoustic quality and clinic/staff
acceptance keep their separate requirements. This target does not select a
clinical speech profile or enable patient traffic.

The additional test-only probe code provides explicit dialogue, interruption
and fallback scenarios, signed callback collection and exact parent/child
readback. Its presence does not change this target's six-session limit or count
as a carrier pass. The callback route must forward to the separate caller listener and be
configured before the target window opens; see
[the automated caller guide](../phase-1/AUTOMATED_CARRIER_REHEARSAL.md).
