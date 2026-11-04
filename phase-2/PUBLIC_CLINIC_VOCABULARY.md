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

The backend `ClinicVocabularyReview` service offers `propose` and `save`.
Supply it through `ClinikoAdminDashboardConfig.vocabularyReview`, or through the
existing authenticated host's `vocabularyReviewFor` callback. The optional
`/api/clinic-vocabulary` route uses the existing current identity, exact Host and
POST Origin checks. The body cannot choose an actor, scope, file or provider.
Only the current named approving clinic administrator at the exact location may
review. Identity is rechecked at write commit as well as request dispatch.
There is no second authentication mechanism or assistant/model self-approval.

Both full and availability-setup dashboard bundles provide the optional Clinic
terms editor. It appears only on a configured administrator surface. Additional
manual terms require an explicit public-publication confirmation. A stale editor
must reload; a lost or unverifiable save response disables resubmission until
current state is read. No write is automatically replayed. Unconfigured
surfaces retain their prior markup and do not request the optional endpoint.

Proposals write nothing. A save supplies the exact expected approval binding,
saved revision, current catalogue hash, explicitly public manual terms and
explicitly selected suggestions. Refresh retains manual terms and remembered
deletions. Removal records survive file serialization and subsequent editor
instances; a refresh cannot restore them. An owner may explicitly restore a
removed public term. Versions increase even when an owner returns to earlier
terms, so an old editor cannot revive an earlier revision.

Application writers serialize using an exclusive owner-file review lock, then
recheck the saved binding, current owner membership and source and current request authority before atomic
replacement. Only one competing review can commit. A stale or malformed save
preserves the accepted file. Owner approval, membership, catalogue and permissions
are rechecked after the final asynchronous sign-in lookup, so a withdrawal during
that lookup cannot be overwritten by the review. A crash-left lock is refused; reconcile the actual
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

`ReviewedClinicVoiceProfiles` is the optional live `voiceProfiles` implementation
for an existing standalone voice server or admin composition. It captures owner
files afresh on each profile resolution, so an accepted review is seen by later
sessions without a restart. The bounded factory map holds only the latest ready
profile hashes. Concurrent requests share one bounded current-source read and
receive separate declaration objects. An aborted waiter cannot cancel another
healthy caller. A failed current capture withdraws old factories. Existing captured adapter
ports retain their own current-source guards.

Its `locationScope` is enforced by the admin and voice-server compositions: a
location-bound catalogue cannot be installed over routes at another location.
The default OpenAI registry has no added restriction or configuration change.
Pass the same scope and private source files to the review and voice
compositions; neither object is installed automatically by this extension.

The existing profile quality callback must separately qualify the exact new
configuration. A changed approval or vocabulary cannot inherit evidence from
an earlier configuration. No real Krisp access, denoising comparison, repeated
quiet/noisy/date/correction/accent pass, general voice readiness or deployment
follows from a vocabulary or fake-provider test. Preserve all failed acoustic
results and the unchanged gate.

## Qualification still required

Before delivery, finish combined source/emitted/browser checking, review the
public-only source and concurrent save/abort/revocation boundaries, and qualify
unchanged full-project strict checking plus exact PR and actual-main CI. A local
whole-project attempt exhausted its 1536 MiB Node heap before its test phase;
that failure is preserved and supplies no typecheck pass. The narrower inherited
graph and serving checks retain their distinct scopes. Clinic provisioning,
representative per-location call latency and all acoustic/clinic acceptance must
still be exercised before activation. Current local evidence is recorded privately; this document
does not claim those delivery or operating gates have passed.
