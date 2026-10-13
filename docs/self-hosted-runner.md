---
kind: living
status: current
---

# Self-hosted macOS CI and release runner

This document is authoritative for runner routing, trust, availability, and recovery.
`docs/ci-performance.md` owns CI/E2E execution profiles and performance evidence; `RELEASING.md`
owns release steps and refers here for runner operations.

## Scope and trust boundary

Caxri retains one repository-level private final runner for two transitional routes: the owner-dispatched
`self-hosted-final` full E2E run while the repository is private, and the release-commit publication
job. Its labels remain `self-hosted`, `macOS`, `ARM64`, `caxri-ci`, `caxri-e2e`, and
`caxri-release` until phase-two runner removal. Pull-request and main checks, targeted smoke, and
the no-publish package rehearsal run on GitHub-hosted runners. The required `guards` check and the
scheduled Renderer performance trend run on `ubuntu-latest`; Linux release natives retain their
`ubuntu-24.04` x64/ARM64 matrix.

Superseded PR runs must release the same-ref concurrency slot. The E2E job and final gate use
`!cancelled()` at job scope: dependency failures still reach the gate, while cancellation stops
obsolete jobs from waiting for the runner. Step-level `always()` cleanup remains mandatory.
This follows [GitHub's cancellation guidance](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#canceling-workflows).
Do not treat a cancelled run or its skipped gate as successful validation of a deliverable head.

The runner deliberately reuses an existing macOS user. This is a trust decision, not an isolation
boundary: workflow code can access anything that user can access, including Home and Keychain
material. Temporary profiles, blocked Agent discovery, owner-scoped cleanup, and a clean checkout
prevent accidental inheritance; they do not contain malicious workflow code.

Only an explicit owner `workflow_dispatch` with target `self-hosted-final` may execute CI source on
this machine, and that route fails unless the repository is private. Pull requests, including
external forks, use read-only hosted CI with no secrets or write permission. Ordinary merges to
`main` run hosted checks and never start full E2E automatically. After the repository becomes
public, `hosted-full` is the explicit complete E2E route and `self-hosted-final` rejects the event.

Repository visibility must not become public while any repository-level self-hosted runner remains
registered. The Public transition requires a REST readback of zero runners first. Workflow event
guards reduce accidental routing but are not a security boundary against a fork that changes its
own workflow; runner removal is the boundary.

The downstream Release job runs only after the trusted release commit passes hosted CI. That job
receives a short-lived `GITHUB_TOKEN` with `contents: write`
only for tag and Release publication. Checkout credentials are not persisted. No Apple signing,
notarization, personal, or production credentials belong in the workflow.

Never add personal or production credentials to Actions secrets, job environment variables, or
E2E fixtures for this runner. Full E2E keeps Agent discovery `blocked`; specs that need an Agent use
only the repository fake fixtures and profile-scoped provider state. The manual real-Agent smoke is
not eligible for this runner workflow.

## Normal operation

Keep the Mac connected to power with the runner user logged in and the desktop unlocked. Normal
operation uses the per-user launchd service:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh status
```

Job preparation recovers detached Servers left by earlier CI runs before admitting new work.
Recovery requires this checkout's exact Server executable and a canonical profile beneath its
`RUNNER_TEMP/<owner>/tmp` boundary; a process name or an old PID alone is never authority. It
excludes the current run, protects the cleanup process ancestry, freezes the historical root set,
tracks descendants across reparenting, and checks process start identity before every signal.
Teardown first requests termination, then escalates within a bounded window and verifies exit.
If termination cannot be verified, cleanup fails and retains the profile and ownership evidence.

For manual maintenance, establish an idle runner window and review the exact historical process
inventory first. Run identifiers are not execution order: a queued older run can start next, so
never expand a cleanup to newly observed roots based only on a numeric run cutoff. Do not stop
the runner's current job, an installed app, or a development worktree by executable-name matching.

The native compatibility spike writes a disposable file and requires that file's event from the
artifact's actual watcher binding. `event-delivered` is the success receipt; merely subscribing
does not prove event delivery. A failure should be compared with an isolated native probe and
process/resource measurements before changing timeouts or the watcher backend. Recovery of a
system-wide file-event daemon is an explicit operator action, never an automatic CI cleanup step.

Use the foreground listener only for troubleshooting after stopping the service:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh stop
caffeinate -dimsu ./run.sh
```

The runner application updates itself by default. After an update, macOS or Xcode change, stop the
service and repeat one explicit self-hosted control validation before returning the runner to normal
PR traffic.

## Toolchain and caches

`.github/actions/setup-caxri-job/action.yml` owns the common job setup. `actions/setup-node` provides
the exact Node version from `mise.toml`, while `pnpm/setup` installs the exact pnpm version. The
action reads the Bun version from `.bun-version`. On GitHub-hosted jobs, pnpm, Bun, Electron, and
Playwright use disposable `RUNNER_TEMP` paths and do not assume a prewarmed runner cache. On the
remaining self-hosted final path, runner-owned paths do not replace the user's interactive Node,
pnpm, or Bun installations.

Node uses the standard Actions tool cache. pnpm and the Bun binary use versioned directories beneath
`RUNNER_TOOL_CACHE/caxri`; the Bun binary must match `.bun-version`, remains separate from `~/.bun`,
and the job fails closed if it is missing or stale. The pnpm store, Electron, ESLint, and Prettier
caches live under the same runner-owned root. The workflow does not upload these caches to GitHub.
Checks, E2E, and Release jobs that consume the dependency graph run a fresh frozen-lockfile install.
The retry-policy job intentionally uses only runner-pinned Bun and repository source while deriving
the execution plan. Cleanup removes workspace cache links without deleting runner-local toolchains
or cache contents.

The Release job also builds the Android update APK (`docs/mobile/update.md`), so the runner account
keeps the Android toolchain from `apps/mobile/README.md` installed: a JDK 17 in `JAVA_HOME` or the
Gradle JDK cache, and `~/Library/Android/sdk` with Platform 36, Build Tools 35.0.0 and 36.0.0, the React Native NDK
version, and CMake 3.22.1. The release signing key comes only from repository secrets and is
written to `RUNNER_TEMP` for the single build step. A missing toolchain or secret fails the release.
Gradle resolves the build's dependencies into the runner account's persistent `~/.gradle` cache,
which job cleanup keeps. A cold cache downloads from `dl.google.com` and Maven Central inside the
job; when those downloads time out in the job but succeed from the runner over SSH, warm the cache
as described in [Remote diagnosis](#remote-diagnosis) instead of rerunning the release until it
passes.

The runner deletes `_work/_actions` at the start of every job, so that directory is intentionally
ephemeral and must never be treated as the persistent action cache. External actions are pinned to
full commit SHAs, and the runner's supported archive cache keeps their GitHub tarballs outside
`_work`. Configure or refresh it from the current repository checkout with Git transport, which
does not depend on `codeload.github.com`:

```bash
bun run scripts/configure-actions-runner-cache.ts --runner-dir "$RUNNER_INSTALL_DIR"
cd "$RUNNER_INSTALL_DIR"
./svc.sh stop
./svc.sh start
```

The configuration writes `ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE` to the runner's `.env` and stores
archives under `_action-archive-cache` by default. Restarting the listener is required because it
loads `.env` only at startup. Refresh the cache before merging a workflow change that adds or
updates an external action pin. Verify the environment assignment and every required archive
without network access:

```bash
bun run scripts/configure-actions-runner-cache.ts \
  --runner-dir "$RUNNER_INSTALL_DIR" \
  --verify-only
```

Do not hand-populate `_work/_actions`: even a correctly extracted action and `.completed` marker is
removed before the next job. A missing archive cache entry falls back to codeload and can therefore
fail before checkout when the shared egress IP is rate-limited.

## Preflight and teardown contract

Every self-hosted job that checks out and executes repository source:

1. verifies the trusted actor, repository, event, macOS/ARM64 runner, exact checkout head, clean
   workspace, and free repository desktop lease before installing dependencies;
2. assigns a bounded run owner to every inherited process and desktop lease;
3. isolates temporary files and provider state under the job's `RUNNER_TEMP` directory;
4. records runner identity and exact head; each job adds the route, timing, cache, manifest, and test
   count fields that apply to its role, while cleanup failures remain visible in the job summary;
5. terminates only processes carrying the exact run owner, reclaims only dead leases carrying that
   owner, removes only a matching marked temporary root and known generated workspace outputs, and
   fails if any lease or source-workspace change remains.

Cleanup failures are job failures. Do not replace owner checks with `pkill`, process-name matching,
or a broad temporary-directory deletion.

## Transitional offline behavior

If the private final self-hosted E2E route or the legacy Release route selects the private final runner while it is
offline, unhealthy, busy, or under maintenance, that matching job remains queued until the machine
returns. Ordinary pull-request checks, main checks, and targeted smoke run on GitHub-hosted runners
and do not wait for this machine. Do not treat a queued self-hosted job as successful.

Because one physical runner owns all capability labels, jobs execute serially. The full E2E path is
one job that runs its two logical pools in sequence after one setup/build; checks, E2E, and Release
still cannot compete for the same workspace or native UI. This preserves one desktop owner while
allowing the explicitly isolated `parallel-safe` pool to use namespaced workers internally: three by
default (`CAXRI_E2E_PARALLEL_WORKERS`, which a `workflow_dispatch` A/B run may set to 2, 3, or 4).

## Remote diagnosis

Some failures reproduce only on the runner, because its network path, toolchain, and persistent
caches differ from a contributor's machine. Diagnose those on the runner itself rather than
rerunning CI until the failure happens not to recur.

The operator reaches the runner over a private network such as Tailscale, with macOS Remote Login
and key-only SSH. The connection details exist only in the operator's own `~/.ssh/config`. Replace
the placeholder below locally with the runner name reported by GitHub; never commit the real alias:

```sshconfig
Host <runner-name-from-GitHub>
  HostName <private network address>
  User <runner macOS account>
  IdentityFile <operator private key>
  IdentitiesOnly yes
```

Never commit the address, account, key path, or the runner's home path. CI logs already print that
home path, so redact it when quoting a log in an issue or pull request. A replacement runner gets
an alias under its own name.

An agent resolves the runner name from the failing job, maps it through the operator's untracked
SSH configuration, and never waits on an interactive prompt:

```bash
runner=$(gh api repos/tjx666/caxri/actions/jobs/<job-id> --jq .runner_name)
ssh -o BatchMode=yes -o ConnectTimeout=8 "$runner" '<probe>'
```

If the alias does not resolve or key authentication fails, report that and stop; never guess an
address or account. On the runner:

- Probe read-only: DNS resolution, `curl` against the failing URL, and the toolchain the job
  selects. The runner's `.env` supplies job variables such as `JAVA_HOME`; read only the variable
  you need, and never print the environment or other values.
- Reproduce with the job's own toolchain from a `mktemp -d` directory and delete it afterwards.
  Warming a persistent dependency cache this way is allowed, because the job would write the same
  entries.
- Confirm the runner is idle with `gh api repos/tjx666/caxri/actions/runners` before a probe heavier
  than a request, and never touch a job workspace.
- Do not change the proxy or network configuration, the runner service, its registration, or macOS
  settings, and do not use `sudo`. Report those as operator actions.

## Validation and recovery

Before removing the runner in phase two, freeze one exact private-repository head and record one
owner-dispatched `self-hosted-final` full E2E result with the expected Node/pnpm/lockfile, profile,
manifest hash, test count, skip count, free lease, clean profile, and successful teardown. Do not
repeat it for performance sampling. The frozen cleanup ledger and owner-only dispatch are the
single-execution gate; the workflow does not treat concurrency cancellation as durable proof that a
previous successful dispatch exists. The hosted no-publish rehearsal separately proves cold package
setup, both DMG flavors, Linux natives, the ephemeral Android signing path, and targeted packaged
smoke without creating a tag or Release.

If unauthorized code ran, credentials may have been accessed, cleanup ownership cannot be proved,
or the machine shows unexpected credential access:

1. stop the listener or service immediately;
2. remove the repository runner in **Settings -> Actions -> Runners**;
3. preserve only content-free runner, Main, and Runtime diagnostics;
4. rotate credentials reachable by the macOS user, not only Actions secrets;
5. inspect and clear verified Caxri-owned processes, leases, worktrees, and profiles;
6. register a fresh runner token and repeat the full validation matrix before recovery.

### Permanent loss and replacement

When the machine is permanently unavailable or cannot be trusted for reuse:

1. remove its repository registration in **Settings -> Actions -> Runners**; if the machine cannot
   be reached, treat the remaining registration as lost rather than trying to recover a removal
   token from it;
2. provision a replacement macOS ARM64 machine and runner user, then register it with a temporary
   non-routing label and keep its listener stopped; do not add `caxri-ci`, `caxri-e2e`, or
   `caxri-release` yet;
3. configure and verify the runner-local action archive cache with the commands in
   [Toolchain and caches](#toolchain-and-caches) while the listener remains stopped;
4. open a controlled admission window: freeze pushes, PR reruns, and manual dispatches; cancel every
   queued CI and Release run; then verify that no matching work remains queued before adding the
   standard labels `self-hosted`, `macOS`, `ARM64`, `caxri-ci`, `caxri-e2e`, and `caxri-release`;
5. start the per-user launchd service and dispatch only the complete frozen-head validation matrix
   above. If any unrelated job appears, stop the listener, remove the capability labels, and restart
   the admission window;
6. restore normal repository traffic and retrigger cancelled work only after the complete matrix
   passes. A failed matrix returns the runner to its stopped, non-routing state.

During replacement, hold only the explicit self-hosted final and publication routes rather than
leaving them queued for an unvalidated listener. Hosted checks, targeted smoke, and the no-publish
rehearsal keep their fixed hosted routes. Local lint, typecheck, unit, build, or focused E2E results
remain provisional local evidence; they are not exact-head GitHub checks. If the capability labels
must change permanently, review the workflow and its contract tests as a separate repository
change after the replacement is available.

To remove a healthy runner intentionally:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh stop || true
./svc.sh uninstall || true
./config.sh remove --token "$REMOVE_TOKEN"
```

Registration and removal tokens are one-hour credentials. Keep them in shell variables, never in
the repository, shell history, job summaries, or logs.
