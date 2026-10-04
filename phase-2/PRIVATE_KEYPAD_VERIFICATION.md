# Private keypad caller verification

**Status:** opt-in trusted voice interface with authenticated synthetic wire and actual verifier/read tests. The production standalone runner leaves it unset. This provides no real mail delivery, clinic authority, patient permission, carrier proof or write activation. Email delivery remains deferred; D-18 remains unselected.

## Behaviour and ownership

A trusted host creates one `PrivateKeypadVerification` for an exact call ID and session ID. Its owner getter returns the actual `CallerVerificationSession` constructed after single-location admission. `TwilioConnectedCall` claims that input once, then starts the email challenge only after its admitted voice owner has attached. Missing, foreign, reused or changed owners fail closed. Shared-number location selection is not supported in this initial mode; it must finish in a separately designed trusted flow before secret entry can be enabled.

The clinic's approved opening words must explain the email method and six keypad digits followed by pound (`#`); star (`*`) clears the current entry. Synthetic tests use an explicit approved prompt. The input interface supplies no wording approval and no evidence the prompt was heard. Existing playback marks remain separate from mail transport acceptance, code verification and later informed action confirmation.

During code entry and the subsequent private-audio drain:

- Media is decoded/validated and consumed in sequence, but its audio is not retained, sent to transcription, emitted as a caller turn or passed to an intent/model resolver. Spoken code answers are unsupported.
- Keypad digits go only into a six-digit volatile buffer. A seventh digit or nonnumeric keypad letter invalidates that entry; pound submits one bounded answer, including malformed entries. Three denied submissions close the actual call. Star clears the buffer without allocating a new email challenge.
- Ordinary keypad availability choices are suppressed. Progress contains only `privateInput` or a generic typed failure, never digits, code, contact, patient existence, token or proof.

Wire arrival captures whether an event is private before the serialized call queue waits. Audio/digits queued while code verification is pending remain private even if verification succeeds before those events are handled. After success, transcription stays suppressed until 500 ms of contiguous, validated new PCM frames fall below the configured speech threshold. Voiced frames and timestamp gaps reset the interval. Silence that arrived while verification was pending cannot establish it. Later ordinary media then continues with the same validated sequence and timestamp history; only protected host wiring receives the private proof. The composed read still rechecks current patient/contact/operation authority. This is not permission to book, cancel or reschedule, and no caller/model command configures this interface.

On stop, malformed transport, overload, lease loss or disconnect, the call synchronously closes private input and disposes its verifier before waiting for serialized work. Late mail or code completion cannot reopen media or restore proof. Idle/playback deadlines and the verifier's bounded dependency waits, three-answer cap, current approval/member/permission checks, aggregate abuse budget and original five-minute proof expiry still apply. Replacement processes receive no saved challenge or proof.

## Function map

| Function | Input | Output and ownership |
| --- | --- | --- |
| `CallerVerificationSession.binding()` | Trusted host only | Exact call/session binding without patient/contact/proof data |
| `PrivateKeypadVerification.claim(callId, sessionId)` | Transport owner binding | Single successful claim or false; another call/session cannot reuse it |
| `start()` | Already attached admitted owner | Starts one existing email challenge; validates the actual owner's binding |
| `accept(digit)` | Authenticated private keypad event | `pending`, `verified` or `failed`; owns bounded buffer and answer submission |
| `blocked()` | None | Whether code verification still blocks input; the transport adds the mandatory fresh quiet interval |
| `stop()` | Transport teardown | Clears buffer and closes owned verification; no late restart |
| `TwilioConnectedCall.receive()` | Already authenticated wire message | Captures private arrival state, validates wire order, then serializes semantic handling |
| `MediaTurnController.discardPrivateMedia()` | Validated private audio frame | Consumes sequence/time and reports quiet-frame duration; refuses pending ordinary work and never calls transcription or target |

The `PrivateKeypadInput` interface is trusted transport wiring. A buyer may supply its own call-bound verifier behind this interface; its implementation must start blocked, honor one owner, suppress secrets and close synchronously. The portable SAM has no OTP command, second decision loop or provider-specific secret fields.

## E2E-294 evidence scope

The actual `TwilioSignedIngress`, media decoder, call admission/lease/SAM owner, email verifier, clinic approval reader and protected Cliniko reader compose with synthetic remote contact/mail/permission/HTTP and synthetic audio adapters. Tests cover successful star correction and verification/read, no transcription/model/SAM turn from private audio, normal input after success, overflow/malformed/three-answer closure, current permission/approval denial, foreign or reused input, held mail with queued private media/digits/earlier silence, post-verification code audio, discontinuous quiet frames, disconnect and late completion. Disabled private mode preserves ordinary keypad handling; forged webhook/upgrade signatures are rejected before admission.

Actual disposable PostgreSQL supplies the clinic aggregate issue/answer budget. Table and backup scans exclude code, email, chart/patient ID, call/session and proof canaries; call and phone-index tables stay empty. These are authenticated synthetic wire calls in process, not a network WebSocket rehearsal, real mailbox delivery or carrier audio/playback proof. The live listener and runner do not construct this mode. Actual clinical permission, clinic/review approval, secret-entry rollout, real delivery and provider/voice activation gates remain open.
