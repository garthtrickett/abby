# Phase 0 capability support matrix

**Status:** Draft evidence ledger, not product-approved. `Unverified` is a research status, not an executable capability decision. No mutation is approved for automation by this matrix.

| Core capability | Reference host | Cliniko demo profile | Splose profile | Required next proof |
| --- | --- | --- | --- | --- |
| Resolve clinic and settings | Versioned reference policy store and next-call capture; number routing unimplemented | Metadata GET 200 (C-LIVE-01); fields and policy mapping unverified | Unverified; no account | Prove scoped snapshot, setting versions, and permissions. |
| Find patient candidates and verify | Exact synthetic proof-ref lookup; real verification method unimplemented | Unverified; no patient probe | Unverified; no account | Approve verification method and test scoped, synthetic candidate flow. |
| Find appointments | Contract target, unimplemented | List metadata GET 200 with zero records (C-LIVE-01); patient and target binding unverified | Unverified; no account | Test synthetic appointment lookup and ambiguity without disclosing unrelated records. |
| Find bookable offers | Exact seeded synthetic offer-ref lookup; discovery unimplemented | Blocked in current demo configuration: business online-booking flag false; offer GET 404 (C-LIVE-02) | Unverified; no account | Enable or identify an eligible test combination and prove bounded host-issued offers. |
| Book appointment | Synthetic keyed booking and exact reconciliation in reference fixture only | Provisional request-only; no write-safety proof | Unverified; no account | Synthetic fixture, current permission at commit, offer revalidation, exact lost-response outcome. |
| Cancel appointment | Contract target, unimplemented | Provisional request-only; no write-safety proof | Unverified; no account | Exact target, current permission, definitive cancel and lost-response outcome. |
| Reschedule appointment | Contract target, unimplemented | Provisional request-only; atomicity unproven | Unverified; no account | Host-native or atomic replacement and exact recovery. |
| First-time patient intake | Contract target, unimplemented | Provisional request-only; consent and duplicate behavior unproven | Unverified; no account | Approved consent, duplicate check, stable patient ref, exact recovery. |
| Open and reconcile staff task | Synthetic keyed task open and operator-review fallback; exact task reconciliation unimplemented | Unverified | Unverified; no account | Approved task destination and stable task key or visible operator-review fallback. |

The reference fixture demonstrates core composition only; it is not a production host or evidence for another provider. Splose stays unverified until account access and probes are available; its API documentation alone cannot establish account behavior. Product approval must assign each profile and capability a final `execute`, `requestOnly`, or `unavailable` mode with the cited evidence and a safe fallback. A known unsupported or unsafe mutation never inherits execute mode from another provider.
