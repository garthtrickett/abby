# Selected queue-work freshness

This optional operator diagnostic implements the R23 freshness check within gap 3. It has local source/build and actual OS-reader evidence. Final current metadata, fixed-head review, own CI and normal delivery remain required. It is not an installed monitor.

## Contract

The existing queue-monitor command returns success for its known queue result. This diagnostic observes an explicitly selected systemd oneshot/timer pair and distinguishes actual recent command completion from process-UP, a timer trigger or a default success value. It performs no Cliniko read and proves neither current clinic readiness nor complete call inventory, approved duty or human receipt.

Use the same trusted owner-selected name, application root, Node path, private environment-file path and expected cadence as the accepted rendered queue profile. The environment path is matched as part of the command; its contents are not loaded. This is an operator-only CLI, not a caller/model argument surface or web endpoint. Exact deployed source/configuration, the local manager and clinic approval remain independent prerequisites. Matching a path is not source-hash or permission proof.

The native source is qualified on Linux, systemd 255 and Node 22.23.0/libuv 1.51.0; other native Node/platform versions return unavailable until qualified. It uses bounded local systemctl show and busctl get-property reads and the verified Linux monotonic clock. Two stable observations bind the selected target, normal zero-exit profile, working directory, real nonzero ordered process start/exit bound to the latest unit activation and invocation identity. The selected timer must remain active. Missing or changing metadata, reloads/drop-ins, cancellation and unsupported sources stay unavailable. A bounded local `/proc/uptime` read supplies a separate conservative suspend-inclusive age ceiling. There is no retry, journal read or unit-control operation.

Systemd can publish activation after spawning the main process. Completion must follow the latest activation; a running observation needs matching current/main-execution PIDs. An unavailable current-unit completion record is not proof that no historical invocation ever ran.

A new pending/running invocation cannot inherit old success. Resetting a failed unit cannot manufacture completion. The age allowance is the configured cadence plus the existing 210 s queue-command bound. The whole observation has an independent five-second deadline. This is a point-in-time result, not a guarantee of the next run.

## Use

Build the command with the existing runtime or fixture-inclusive build. From the accepted release directory:

    npm run voice:ops:queue-work -- --name abby-cliniko-queue --manager system --app-root /srv/abby --node-bin /opt/node-v22.23.0/bin/node --env-file /etc/abby/queue.env --poll-minutes 15

Select user only for the accepted user-manager profile. The name omits the service/timer suffix. The example approves or installs nothing; its paths and cadence must be replaced with the actual accepted configuration.

Output is one fixed status object. Only recentCompletion exits 0. neverCompleted, pending, running, stalled, missed, disabled, failed and unavailable exit 2. Running describes invocation, not completed work. Unavailable is not healthy zero. An independently approved monitor/operator policy decides how to respond; nonzero does not itself prove an incident or send a page.

No raw source error, command/environment value, unit name, host path or clinic/call/patient identifier is returned. No state is written. Existing aggregate alert receipts gain no timestamps or fields. No booking result, quota, verification, contact/capacity hold or clinic grant changes.

## Local engineering, 23 October 2026

The initial source cohort passed 37 controls without skips: defaults versus completion, new work over old success, age boundaries, failed/disabled/missed/stalled work, source/profile refusal, changed reads, clock rollback, cancellation and the actual five-second deadline. E2E-220 registration retains their assertions; final naming and metadata qualification follows.

Whole strict TypeScript and the runtime-only compiler passed. The initial supervisor then failed a wrong artifact comparison:492 runtime-only outputs could not equal the older 741 fixture-inclusive graph plus two new outputs. All490 prior outputs actually built matched. This failed inventory gate and its narrower original guard remain preserved; sixteen omitted auxiliary probe/config inputs were separately reconciled. The corrected expanded 1,811-input fixture-inclusive build passed with 743 outputs, all 741 prior outputs unchanged, plus two optional checker outputs.

A separate actual compiled-reader cohort passed seven OS/process observations without skips: armed calendar before invocation; successful calendar command; stopped schedule; new held work over old success; owned-process SIGKILL; failure reset; and nonzero exit. It used real local systemd/busctl reads with a synthetic selected command. Every temporary service, timer, anchor and fixture file was verified removed. No provider/DB request, production installation or alert send occurred. These are not real clinic/backlog or human observations.

Fast-forward to actually normally merged documentation parent3213032 preserved all1811 source inputs and743 artifacts. PR592 own eight, parent four and resulting-main four jobs passed with complete raw logs/counts independently verified. This patch keeps separate publication and delivery gates.

## Activation-order correction

The first activation correlation refinement failed its actual native recheck: the calendar command completed successfully, but the diagnostic returned unavailable. Only its initial never-run observation passed. All owned fixtures were cleaned up. A bounded owning diagnostic then measured process start145 microseconds before the activation notification, with exit afterward. Systemd255 [spawns the oneshot main before publishing its start state](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L2389); [unit notification records the activation timestamp](https://github.com/systemd/systemd/blob/v255/src/core/unit.c#L2740). Assuming fork start followed that timestamp was incorrect.

The correction binds completion after the latest activation and uses matching current/main-execution PIDs for running work. It adds no time tolerance and preserves old-success refusal. Current source41 plus both facts/scenario checks pass43/43, no skips. Fresh whole strict and fixture-inclusive compilation pass with743 outputs; all741 prior outputs remain exact. The seven actual compiled-reader OS/process observations pass again on these exact corrected bytes, and every owned unit/fixture is removed.

These actual OS observations use a user manager and synthetic commands. Actual system-manager/clinic deployment, its complete accepted configuration and real queue/backlog/human acceptance remain unexecuted. The source, type/build and native cohorts are separate evidence, not a summed full-call pass. The failed native refinement and wrong-target inventory run remain in the execution history.

## Review corrections and current qualification

The fixed-head review found two missing boundaries: monotonic age excludes suspend, and the actual process cohort had no successful recovery after failure. It also suggested sharing the repeated pending-age policy. All three findings were accepted.

Event ordering still uses the qualified monotonic clock. A fixed local `/proc/uptime` read accepts at most 64 bytes and rounds the kernel's truncated centiseconds upward. This BOOTTIME value includes suspend and supplies only a conservative upper age, never an interchangeable event clock. Completion, running and pending-age claims become unavailable when only this upper bound crosses their allowance. A monotonic age already beyond its limit remains expired. Two suspend-inclusive captures also reject a whole observation beyond five seconds. Missing, backward or contradictory clock bounds are unavailable. Cumulative suspend before the invocation can conservatively refuse an otherwise recent completion; no healthy result is inferred from that uncertainty.

The corrected cohort passes 45 behavioral controls plus both metadata checks (47/47, no skips). Fresh whole strict TypeScript and fixture-inclusive compilation pass with all 743 outputs accounted for and all 741 prior outputs exact. The first compile launch refused live memory admission before starting a compiler; the unchanged frozen runner later passed after fresh admission, with no peer interruption.

The expanded native cohort first passed eight observations, including genuine recovery, but its completion timestamp changed while awaiting the missed-age boundary. That comparison did not retain the changed fields; a rearmed relative trigger is an inference from its fixture, not a captured lifecycle diagnosis. All owned units and files were removed and the failure is preserved. A successor uses one annual calendar occurrence in the next minute, avoiding a rearmed relative trigger. It passes all nine actual compiled-reader observations, including recovery after failure and the unchanged completion aging past the selected one-minute cadence plus the original 210-second allowance. The wait reaches a real 271-second age; no test cadence or deadline was shortened. All owned units and files are verified removed.

These remain synthetic selected commands under a user manager, not a real clinic/backlog or system-manager deployment. Final documentation-only metadata recheck, fixed-head review and ordinary own/main delivery remain required before landing this patch. No monitor, receiver, staff authority, provider request or default activation is introduced.

## Remaining acceptance

Approve the actual release/configuration, rendered units, local manager, cadence and monitoring receiver independently. Exercise real stopped/missed/late work and primary/backup responsibility and expiry under that setup. The backup role is practice manager or senior receptionist; a distinct approved person/account, verified destination and human acknowledgment remain required.

Monitor sender, receiver and host outside their own processes. This local command cannot detect loss of its own host or deliver a page when nobody runs it. All thirteen gaps, speech/provider/source/restore/retention acceptance and deployment decisions remain open.

## Source contract

[Systemd255 execution/timer properties](https://www.freedesktop.org/software/systemd/man/255/org.freedesktop.systemd1.html) and [machine-readable properties](https://www.freedesktop.org/software/systemd/man/255/systemctl.html) define the selected source. The qualified Node22.23.0 [process binding](https://github.com/nodejs/node/blob/v22.23.0/src/node_process_methods.cc), [libuv call](https://github.com/nodejs/node/blob/v22.23.0/deps/uv/src/unix/core.c) and [Linux clock](https://github.com/nodejs/node/blob/v22.23.0/deps/uv/src/unix/linux.c) establish the monotonic clock. Linux uptime includes suspension and is not treated as interchangeable with monotonic event timestamps. Its [kernel implementation](https://github.com/torvalds/linux/blob/v6.8/fs/proc/uptime.c#L26-L35) provides the separately rounded conservative ceiling described above.

[Implementation](../src/standalone/cliniko-queue-work-status.ts), [CLI](../scripts/check-cliniko-queue-work.ts), [source tests](../test/voice/cliniko-queue-work-status.test.ts), [existing queue monitor](../scripts/monitor-cliniko-queue.ts), [rendered profile](../scripts/render-voice-ops-systemd.mjs), [operator response](../deploy/voice/OPERATOR_RESPONSE.md), and [original R23](KAREN_TO_ABBY_REUSE_AUDIT.md#r23-make-startup-and-monitoring-prove-fresh-work).
