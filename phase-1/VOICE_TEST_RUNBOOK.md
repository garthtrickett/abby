# Isolated real-call rehearsal

**State:** the local test-call path and synthetic process E2E exist. No public Abby endpoint, Twilio number route, independent fallback Function, or carrier call has been verified yet. This runbook prepares a disposable test route; it is not clinic activation.

## Boundaries

- Use a dedicated Twilio number, one explicitly allowed test caller, the demo Cliniko account, and no real patient data. Caller ID is only a presented clue and can be spoofed; the allowlist limits accidental calls and does not authenticate a person.
- `ABBY_VOICE_TEST_MODE=1` permits a call only when a signed Twilio webhook and signed stream binding identify the configured account, `ABBY_TWILIO_TEST_NUMBER`, and `ABBY_TWILIO_TEST_CALLER_NUMBER`. The runner rechecks PostgreSQL health at ingress. `/readyz` remains 503 because general clinic readiness is unproven. Without test mode, the runner refuses every call.
- Standalone Abby stores no call, audio, transcript, appointment, or outcome record. The isolated test database may contain non-patient clinic settings and automation audit entries. Patient-specific handoff remains disabled. The provider may retain its own call metadata under the test account's settings.
- The number's **Voice Fallback URL** must be independent of Abby and its HTTPS proxy. The post-stream `<Dial>` in Abby's TwiML covers a different failure point. [Twilio's fallback guidance](https://www.twilio.com/docs/voice/twilio-voice-failover-best-practices) distinguishes the two routes.

## Prepare the endpoint and fallback

1. Choose a dedicated DNS hostname for Abby's test endpoint. Point it at the test host, permit inbound 80/443, and deploy [the Caddy template](../deploy/voice/Caddyfile.example) or an equivalent TLS proxy. Caddy is not installed by this repository. Proxy only `/twilio/inbound` and `/twilio/media/` to `127.0.0.1:ABBY_VOICE_PORT`; preserve paths, body, and `X-Twilio-Signature`. Twilio requires a public WSS endpoint on port 443 for Media Streams. [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/reverse-proxy), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams).
2. Deploy [the independent Twilio Function](../deploy/voice/twilio-number-fallback.js) as a public Function in the test Twilio account. Set its `ABBY_FALLBACK_NUMBER` environment variable to a reachable number separate from the caller and Abby number. Fetch the Function URL and confirm it returns `<Dial>` to that destination. The Function contains no Abby database or endpoint dependency. [Twilio Function forwarding example](https://www.twilio.com/docs/serverless/functions-assets/quickstart/receive-call).
3. On the dedicated Twilio number, configure **A call comes in** as webhook `POST https://<test-host>/twilio/inbound` and **Primary handler fails** as `POST <independent Function URL>`. Do not use a Voice Application or SIP trunk on that number; those can override number-level voice URLs. Set `ABBY_TWILIO_PUBLIC_WEBHOOK_URL`, `ABBY_TWILIO_PUBLIC_STREAM_URL=wss://<test-host>/twilio/media/`, and `ABBY_TWILIO_PUBLIC_FALLBACK_URL` to the exact configured URLs. [Incoming number properties](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

## Start the isolated test route

Use an owner-only `.env` or an equivalent secret store, and load it into the process environment before running the commands below; the npm scripts do not load `.env` automatically. Set the existing [voice runner variables](VOICE_SERVICE_RUNNER.md) plus `ABBY_VOICE_TEST_MODE=1`, `ABBY_TWILIO_TEST_CALLER_NUMBER`, `ABBY_TWILIO_PUBLIC_FALLBACK_URL`, `ABBY_TEST_OPERATOR_REF`, and `ABBY_AUTOMATION_EXPECTED_VERSION=0` for a new isolated clinic. The greeting must explicitly identify the call as a test and include both keypad instructions. The route must use a privacy-safe migrated database and a distinct test scope. Keep credentials out of shell history, logs, and Git.

```sh
npm run voice:preflight -- --config-only
npm run voice:test-policy -- enable
npm run voice:local
```

Run `npm run voice:preflight` after TLS, Function, and Twilio number configuration exist. It checks unsigned HTTPS and WSS rejection, the independent fallback TwiML, and the Twilio number's exact primary/fallback URL and `POST` methods. It does **not** prove that Twilio can connect a live call or dial the fallback.

## Carrier rehearsal

Record a pass or failure for each case with the test number, route version, time, and Twilio call SID in a restricted test log outside Abby's database. Do not copy recordings, transcripts, patient data, or credentials into Abby. Stop after the first unsafe result and restore the independent fallback route.

| Case | Expected observation |
| --- | --- |
| Unlisted caller | Abby returns 503; Twilio uses the independent fallback Function; no Abby greeting or Cliniko read. |
| Listed caller, normal call | Signed webhook and WSS stream connect; the approved test greeting is heard; exact playback mark is returned. |
| Keypad 1 and 2 | Each key after the greeting produces the corresponding read-only demo Cliniko availability response; unsupported keys do not trigger reads. |
| Caller interruption | Speaking during Abby audio clears queued output; old audio does not resume and no unproven playback is called complete. |
| Mid-call process stop | Stop Abby while the stream is active; determine whether Twilio executes the post-stream staff `<Dial>` and whether the destination actually rings. Record any duplicate or lost audio. |
| Primary endpoint unavailable | Stop Abby **before** placing a new call; the number-level Function must connect the separate fallback phone. Restart Abby only after the fallback result is recorded. |
| Database or OpenAI failure | With a test call only, prove the caller reaches the configured safe route and no patient-specific work is stored. |
| Normal hangup | Confirm Twilio does not unexpectedly ring the fallback destination after a completed test call. If it does, revise the post-stream route before any clinic use. |

After testing, stop the runner, set `ABBY_AUTOMATION_EXPECTED_VERSION` to the observed new version, and run `npm run voice:test-policy -- disable`. Keep the Twilio number pointed at the independent fallback Function until the next supervised test. General clinic readiness remains blocked by D-09 and D-12 until the real carrier fallback and other clinic approvals are proven.
