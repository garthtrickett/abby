# Approved communication-memo engineering

The owner selected separate confidential Cliniko communication memos for
verified administrative booking, rescheduling and cancellation facts. Existing
appointment and treatment notes remain untouched. This branch currently
implements a native-record primitive; trusted clinical receipt capture,
workflow integration and complete recovery remain unfinished. No default
configuration, live write or completed gap 13 is claimed.

## Native contract

The adapter creates a memo through `POST /communications`, using category 12,
confidential storage and phone-call type 3. Direction 1 means sent and 2 means
received; it must come from the actual authorized conversation. It omits
sender/recipient guesses and unsupported author fields. Numeric codes are
matched independently of illustrative response labels. Creating this record
does not send a communication. The API user and separate clinic author policy
still need approval. [Official communication reference](https://docs.api.cliniko.com/openapi/communication).

Archived reads explicitly request `archived_at:*`, which includes archived
records rather than silently treating their absence from a default view as
absence of the effect. [Official filtering contract](https://docs.api.cliniko.com/#filtering-results).

## Integrity and one-use ownership

The strict codec accepts allowlisted administrative facts, exact individual
appointment references and canonical intervals. It accepts no transcript,
treatment text or arbitrary prose. A separate MAC protects the canonical
original action, subject, account, author, policy, direction and outcome; it
does not prove patient verification, clinical success or permission.

One fixed purpose is derived from the original clinical action UUID. Changing
the key, policy, author or operation label cannot create a second purpose. The
adapter requires independent current native and producer grants, shares the
physical API-user budget, and claims the existing real opaque SQL exclusion
before its only possible POST. It uses a whole deadline and bounded owned body
reader. A known exact acknowledgement remains known when later disclosure is
withheld; headers alone or a lost/nonexact body remain uncertain. A spent
unretained purpose cannot POST again.

The read-only interface needs separate preliminary and decoded-record grants.
It can read a known communication reference; cold discovery without that
reference is not implemented yet. The adapter does not edit or archive records,
add a local private queue, or retry the original clinical action.

## Current local evidence, 21 October 2026

The corrected source cohort passes 46/46 (1792549862370), and its affected strict
graph passes (1792549864095). The earlier type attempt failed only because this
new code used a parameter property forbidden by the repository's erasable-only
TypeScript setting; that syntax is corrected and the failed evidence retained.

Full strict TypeScript and the actual serving build pass (1792550201020,
5m44s, peak 1,664,761,856 B/2 GiB). There are 685 outputs: two new memo modules
and every original 683 output byte unchanged. A single nonemitted SQL driver
was added afterward; its affected strict graph passes (1792550617521), with
all serving inputs and output hashes preserved.

Five actual emitted/PostgreSQL cases pass (1792550728861): exact acknowledgement,
stored and unretained response loss, parallel callers, and policy/key change
after uncertainty. They use the real native-180 SQL budget and permanent effect
barrier, retain unrelated legitimate SQL state, scan every column and inspect
the complete unfiltered backup. Remote native transport, clinical source facts
and grants are synthetic; these cases do not prove an actual clinical receipt
or host integration. Own databases are isolated and cleaned, CPU/RAM bounded,
swap disabled and OOM/high/max counters zero.

## Work still required

Bind rendering and the native producer to actual nominal acknowledgements from
the verified workflow owner. Cover booking, rescheduling, cancellation and
approved per-patient class facts without writing shared-class notes or promoting
partial movement into complete success. Keep known clinical acknowledgement
irrevocable after memo quota, permission, source, observer or response failures.
Exact clinic templates, local presentation, author, confidentiality/viewer roles,
retention and per-operation permissions remain separate requirements.

Add independently permitted complete native history, protected original-bound
recovery without lost local references, process-loss and full logical-restore
proofs. Retain all-column/raw-backup privacy and real physical-budget admission.
Then qualify the actual combined host/serving paths, update operator facts and
scenarios, and complete normal parent integration, exact-head cloud checks and
review before publication. Attachments and other storage types stay separate.

Outbound complete no-stop/private/all-ASR reporting and real acoustic/provider/
clinic acceptance remain open. Independent memo engineering does not close or
bypass those execution-stage requirements or the full thirteen-gap goal.
