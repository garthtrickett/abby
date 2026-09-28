# Default-off automation admission gate

`CallPolicy.automationEnabled` defaults to `false`. `CallAdmissionService` looks up an authenticated provider call key before reading the current route or switch. A matching existing receipt is acknowledged as a duplicate even if automation has since been disabled; a conflicting dialed number still fails. For a new key, a policy without `automationEnabled: true` produces typed `automationDisabled` and writes no call receipt. `AdmissionFallbackCoordinator` sends that outcome to the independently configured number fallback and operational alert. An already admitted call retains its captured policy and may finish.

The PostgreSQL policy reader treats older setting versions without this field as disabled. Memory and PostgreSQL synthetic E2E cover the default, enabled route, disabled new call, existing-call continuation, duplicate replay, and fallback. Tests explicitly mark their synthetic routes enabled; the reference default and standalone dashboard demo remain off.

This is the intake gate, not the full `SET-001` setting. An authorized, audited change command, readiness proof for enabling, and a browser-plus-call journey are still required. No live clinic should be enabled by constructing a policy directly. The number fallback still needs a real provider test before live traffic.
