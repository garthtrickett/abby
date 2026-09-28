# Phase 0 capability support matrix

**Status:** Draft evidence ledger, not product-approved. `Unverified` is a research status, not an executable capability decision. No mutation is approved for automation by this matrix.

| Core capability | Reference host | Cliniko demo profile | Splose profile | Required next proof |
| --- | --- | --- | --- | --- |
| Resolve clinic and settings | Contract target, unimplemented | Metadata GET 200 (C-LIVE-01); fields and policy mapping unverified | Unverified; no account | Prove scoped snapshot, setting versions, and permissions. |
| Find patient candidates and verify | Contract target, unimplemented | Unverified; no patient probe | Unverified; no account | Approve verification method and test scoped, synthetic candidate flow. |
| Find appointments | Contract target, unimplemented | List metadata GET 200 with zero records (C-LIVE-01); patient and target binding unverified | Unverified; no account | Test synthetic appointment lookup and ambiguity without disclosing unrelated records. |
| Find bookable offers | Contract target, unimplemented | Blocked in current demo configuration: business online-booking flag false; offer GET 404 (C-LIVE-02) | Unverified; no account | Enable or identify an eligible test combination and prove bounded host-issued offers. |
| Book appointment | Contract target, unimplemented | Provisional request-only; no write-safety proof | Unverified; no account | Synthetic fixture, current permission at commit, offer revalidation, exact lost-response outcome. |
| Cancel appointment | Contract target, unimplemented | Provisional request-only; no write-safety proof | Unverified; no account | Exact target, current permission, definitive cancel and lost-response outcome. |
| Reschedule appointment | Contract target, unimplemented | Provisional request-only; atomicity unproven | Unverified; no account | Host-native or atomic replacement and exact recovery. |
| First-time patient intake | Contract target, unimplemented | Provisional request-only; consent and duplicate behavior unproven | Unverified; no account | Approved consent, duplicate check, stable patient ref, exact recovery. |
| Open and reconcile staff task | Contract target, unimplemented | Unverified | Unverified; no account | Approved task destination and stable task key or visible operator-review fallback. |

The reference host is a required Phase 1 implementation target, not evidence that its code exists. Splose stays unverified until account access and probes are available; its API documentation alone cannot establish account behavior. Product approval must assign each profile and capability a final `execute`, `requestOnly`, or `unavailable` mode with the cited evidence and a safe fallback. A known unsupported or unsafe mutation never inherits execute mode from another provider.
