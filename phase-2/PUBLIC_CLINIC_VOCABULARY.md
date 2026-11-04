# Reviewed public clinic vocabulary

Work in progress, 4 November 2026. This optional extension implements R13's
review and adapter boundaries. It is not enabled by the standalone server's
default configuration. Local checks, delivery, clinic provisioning and acoustic
acceptance are separate; no new provider request is authorized by this document.

## Source and publication approval

`ApprovedCatalogueVocabulary` reads the complete currently approved booking
inventory for one exact location through `OwnerFileServiceCatalogue`. This is
not an assertion that every service or location in the native Cliniko account
is approved. The current booking catalogue retains its policy, credential,
membership, expiry and exact-content checks.

A separate owner-provisioned `CataloguePublicationApproval` must pin that exact
catalogue binding and list public field references. Supported references are
`service:<serviceRef>`, `practitioner:<practitionerId>` and
`location:<locationId>`. Only the corresponding public service display names,
explicitly approved practitioner display names and location display name can
be extracted. Appointment-type internal names, company descriptions, patient
records, caller speech and model output are not inputs. A booking approval does
not establish publication approval. An operator must verify that every
whitelisted field is already public; neither a syntax check nor an admin role
detects patient information.

Every use also checks that saved selected terms still belong to that exact public
whitelist. A schema-valid hand-provisioned selection cannot substitute an
unpublished catalogue field. The owner review surface can repair such a file
while transcription continues to refuse it.

The input contract rejects incomplete, duplicate, malformed or cross-location
inventories and unknown publication references. Ordering changes have a stable
canonical representation. A changed complete source or publication approval
requires a new vocabulary review; source changes never automatically update a
running call's dictionary.

## Review and persistence

The operator provisions the initial owner-only vocabulary approval file using
`ClinicVocabularyApproval`. Its standard clinic approval must be current and
the vocabulary must be a valid result of `reviewClinicVocabulary`, including an
empty explicitly reviewed dictionary if desired. Keep its containing directory
owned by the service user with mode 0700, and the JSON file with mode 0600.
Do not put these files, their private paths or clinic-specific contents in Git.

The backend `ClinicVocabularyReview` service offers `propose` and `save`. An
embedding admin surface must supply its authenticated actor from the existing
identity boundary, never a request-body actor. This implementation permits the
current named approving clinic administrator at the exact location. It does not
create an admin HTTP route, a new authentication mechanism or authority for an
assistant/model to approve its own suggestions.

Proposals write nothing. A save supplies the exact expected approval binding,
saved revision, current catalogue hash, explicitly public manual terms and
explicitly selected suggestions. Refresh retains manual terms and remembered
deletions. Removal records survive file serialization and subsequent editor
instances; a refresh cannot restore them. An owner may explicitly restore a
removed public term. Versions increase even when an owner returns to earlier
terms, so an old editor cannot revive an earlier revision.

Application writers serialize using an exclusive owner-file review lock, then
recheck the saved binding, current owner membership and source before atomic
replacement. Only one competing review can commit. A stale or malformed save
preserves the accepted file. A crash-left lock is refused; reconcile the actual
writer and file before operator cleanup. There is no automatic lock stealing,
retry, rollback or historical evidence rewriting. All application writers must
use this service; a raw operator edit invalidates existing captured bindings and
must be reconciled separately.

The existing Nova-3 limits remain 50 terms, 80 characters per term and 1,000 UTF-8
bytes in the combined space-joined terms. Suggestions fit remaining capacity
without evicting manual entries. Invalid saves are rejected, never silently
truncated. Removed-term history is bounded at 512 entries and the complete
approval file at the existing 8 KiB owner-file limit; exceeding either requires
explicit owner review rather than dropping suppression history.

## Voice adapter binding

`OwnerFileClinicVocabulary.capture` refuses changed sources, expired or disabled
approvals, changed approving memberships, cross-location data and insecure file
permissions. `captureForReview` lets an owner review a new complete source while
speech capture continues to refuse the old dictionary.

`bindReviewedDeepgramVocabulary` returns an explicitly versioned custom
transcription factory for the existing `OpenAIVoiceProfileHost` seam. The
captured approval and exact dictionary enter its version and physical
configuration hash. The factory is clinic-scoped; a different clinic cannot
resolve or create a profile using it. Scope is also part of the physical
descriptor when supplied. Existing unscoped custom adapters and the default
OpenAI descriptor retain their previous configuration.

The Nova-3 request receives copied, repeated `keyterm` query values. Current
approval, complete source and exact terms are checked around adapter operations;
revocation while a turn is finalizing discards its transcript. Cancelling or
closing one call preserves the independent ownership of other calls. This
does not supply clinical action authority or provider fallback.

The existing profile quality callback must separately qualify the exact new
configuration. A changed approval or vocabulary cannot inherit evidence from
an earlier configuration. No real Krisp access, denoising comparison, repeated
quiet/noisy/date/correction/accent pass, general voice readiness or deployment
follows from a vocabulary or fake-provider test. Preserve all failed acoustic
results and the unchanged gate.

## Qualification still required

Before delivery, finish current strict checking, review the public-only source
boundary and concurrent save/abort/revocation behavior, update affected product
facts, run applicable source and serving checks, and qualify exact PR and actual
main CI. Exercise any embedding admin surface and per-location route wiring
before activation. Current local evidence is recorded privately; this document
does not claim those delivery or operating gates have passed.
