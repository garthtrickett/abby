# Isolated real-call rehearsal

**State:** the local test-call path, synthetic process E2E, disposable public runner rehearsal, credential-free number dry-run, and local fallback Function test exist. No Twilio number route, deployed independent fallback Function, or carrier call has been verified yet. This runbook prepares a disposable test route; it is not clinic activation.

## Boundaries

- Use a dedicated Twilio number, one explicitly allowed test caller, the demo Cliniko account, and no real patient data. Caller ID is only a presented clue and can be spoofed; the allowlist limits accidental calls and does not authenticate a person.
- `ABBY_VOICE_TEST_MODE=1` permits a call only when a signed Twilio webhook and signed stream binding identify the configured account, `ABBY_TWILIO_TEST_NUMBER`, and `ABBY_TWILIO_TEST_CALLER_NUMBER`. The runner rechecks PostgreSQL health at ingress. `/readyz` remains 503 because general clinic readiness is unproven. Without test mode, the runner refuses every call.
- Standalone Abby stores no call, audio, transcript, appointment, or outcome record. The isolated test database may contain non-patient clinic settings and automation audit entries. Patient-specific handoff remains disabled. The provider may retain its own call metadata under the test account's settings.
- E2E-213 proves a new signed local test call can use persisted approval after the runner is killed and restarted. The interrupted call is lost; its state is not replayed, and this synthetic check does not show what Twilio does with that call or its fallback.
- The number's **Voice Fallback URL** must be independent of Abby and its HTTPS proxy. The post-stream `<Dial>` in Abby's TwiML covers a different failure point. [Twilio's fallback guidance](https://www.twilio.com/docs/voice/twilio-voice-failover-best-practices) distinguishes the two routes.

## Prepare the endpoint and fallback

`npm run voice:probe-tunnel` is an optional, self-contained transport smoke test before a number exists. It starts a synthetic signed ingress, opens a temporary ngrok tunnel, verifies unsigned HTTPS/WSS rejection and one signed webhook-to-stream binding, then closes both processes. It uses no clinic, OpenAI, or Twilio account credentials. A pass proves the tunnel path works for synthetic traffic; it does not prove the real runner or carrier.

`npm run voice:probe-runner-public` is the next rehearsal before a number exists. It requires Docker and an authenticated `ngrok` CLI. The command creates a disposable PostgreSQL container and database, starts the **actual standalone voice runner** with synthetic Cliniko and OpenAI ports, opens a temporary public ngrok HTTPS/WSS tunnel, and sends signed synthetic Twilio webhook and Media Stream traffic through that tunnel. It checks unsigned rejection, rejection of signatures computed for a different public URL, signed but unlisted caller refusal, exact public stream URL in TwiML, forged stream binding rejection, greeting media and mark, keypad availability media, interruption clear, clean stream disconnect on runner shutdown, new HTTPS/WSS ingress refusal after the runner stops, and database and backup canaries. The 2026-09-30 disposable run observed HTTP 502 on both public routes after shutdown. The command closes the runner, tunnel, database, and container. It uses generated synthetic signing material and does not load `.env`, use a Twilio number, call Twilio APIs, make carrier calls, or read live Cliniko or OpenAI data. A pass proves the public path into this runner with synthetic traffic; it does **not** prove carrier audio, an independent Twilio fallback Function, actual fallback ringing, or clinic readiness. The ngrok URL is temporary and is never configured on a Twilio number by this command.

1. For a temporary test, run `ngrok http ABBY_VOICE_PORT` (replace the name with the port number) and use its public `https://` host for the webhook and the same host with `wss://` for the stream. Keep the tunnel running during calls. A changing tunnel URL requires updating Abby's exact public URLs and the Twilio number webhook before the next call. Twilio supports an ngrok tunnel for local Media Streams. [Twilio tunnel example](https://www.twilio.com/docs/voice/tutorials/consume-real-time-media-stream-using-websockets-python-and-flask). A stable deployment can instead use a dedicated DNS hostname, inbound 80/443, and [the Caddy template](../deploy/voice/Caddyfile.example) or an equivalent TLS proxy. Caddy is not installed by this repository. Proxy only `/twilio/inbound` and `/twilio/media/` to `127.0.0.1:ABBY_VOICE_PORT`; preserve paths, body, and `X-Twilio-Signature`. Twilio requires a public WSS endpoint on port 443 for Media Streams. [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/reverse-proxy), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams).
2. Deploy [the independent Twilio Function](../deploy/voice/twilio-number-fallback.js) as a public Function in the test Twilio account. Set its `ABBY_FALLBACK_NUMBER` environment variable to a reachable number separate from the caller and Abby number. Fetch the Function URL and confirm it returns `<Dial>` to that destination. The Function contains no Abby database or endpoint dependency. [Twilio Function forwarding example](https://www.twilio.com/docs/serverless/functions-assets/quickstart/receive-call).
3. On the dedicated Twilio number, configure **A call comes in** as webhook `POST https://<test-host>/twilio/inbound` and **Primary handler fails** as `POST <independent Function URL>`. Do not use a Voice Application or SIP trunk on that number; those can override number-level voice URLs. Set `ABBY_TWILIO_PUBLIC_WEBHOOK_URL`, `ABBY_TWILIO_PUBLIC_STREAM_URL=wss://<test-host>/twilio/media/`, and `ABBY_TWILIO_PUBLIC_FALLBACK_URL` to the exact configured URLs. [Incoming number properties](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

Before changing the number route, set `ABBY_TWILIO_TEST_NUMBER`, `ABBY_TWILIO_TEST_CALLER_NUMBER`, and `ABBY_TWILIO_FALLBACK_NUMBER` to three distinct E.164 values, plus the exact public URLs and `ABBY_VOICE_TEST_MODE=1`. Run `npm run voice:preflight -- --dry-run`. It needs no Account SID or Auth Token, makes no network request or change, and prints the intended number, POST primary and independent fallback routes, WSS stream route, and only the last four digits of the fallback destination. Check the plan against the number and Function configuration before applying it. The local Function contract runs with `node --test test/voice/twilio-number-fallback.test.ts`; it cannot establish that Twilio's fallback actually rings.

## Start the isolated test route

Use an owner-only `.env` or an equivalent secret store, and load it into the process environment before running the commands below; the npm scripts do not load `.env` automatically. Set the existing [voice runner variables](VOICE_SERVICE_RUNNER.md) plus `ABBY_VOICE_TEST_MODE=1`, `ABBY_TWILIO_TEST_CALLER_NUMBER`, `ABBY_TWILIO_PUBLIC_FALLBACK_URL`, `ABBY_TEST_OPERATOR_REF`, and `ABBY_AUTOMATION_EXPECTED_VERSION=0` for a new isolated clinic. The greeting must explicitly identify the call as a test and include both keypad instructions. The route must use a privacy-safe migrated database and a distinct test scope. Keep credentials out of shell history, logs, and Git.

For local aggregate diagnostics, optionally set a separate owner-only `ABBY_VOICE_OPERATIONS_TOKEN_HEX` and run `npm run voice:ops` while the listener is up. This prints eight fixed-code, clinic-scoped lifetime counts from the default PostgreSQL store, including local Cliniko budget denials, budget failures, provider 429 responses, and provider 5xx and fetch failures during availability reads. Run `npm run voice:ops -- --daily` for the same codes across seven UTC dates, including zero-filled days. Committed counts survive restart, but an uncommitted increment can be lost on abrupt exit. The reads do not expose a patient-specific call report or prove that a fallback or staff task was delivered.

The local listener removes expired daily aggregate rows before accepting calls and repeats cleanup every six hours. An owner can run `npm run voice:ops:prune` with the same owner-only `DATABASE_URL` to clean idle clinic rows when the listener is stopped. It emits no clinic or patient data. A strict deletion deadline requires scheduling that one-shot command outside the runner; this repository does not install a host scheduler.

```sh
npm run voice:preflight -- --config-only
npm run voice:test-policy -- enable
npm run voice:local
```

Run `npm run voice:preflight -- --transport-only` once the tunnel and local runner are up; it needs only the two public URL values and checks that both public routes reject unsigned traffic. Run `npm run voice:preflight` after TLS, Function, and Twilio number configuration exist. The full check also verifies independent fallback TwiML and the Twilio number's exact primary/fallback URL and `POST` methods. Neither check proves that Twilio can connect a live call or dial the fallback.

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
