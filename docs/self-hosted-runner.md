# Self-hosted macOS CI and release runner

This document is authoritative for runner routing, trust, availability, and recovery.
`docs/ci-performance.md` owns CI/E2E execution profiles and performance evidence; `RELEASING.md`
owns release steps and refers here for runner operations.

## Scope and trust boundary

Caxri uses the repository-level `m2-24` runner for every GitHub Actions job: retry policy,
platform checks, Electron E2E, the final gate, and unsigned arm64 GitHub Releases. Its labels are
`self-hosted`, `macOS`, `ARM64`, `caxri-ci`, `caxri-e2e`, and `caxri-release`. There is no
GitHub-hosted runner route.

Superseded PR runs must release the same-ref concurrency slot. The E2E job and final gate use
`!cancelled()` at job scope: dependency failures still reach the gate, while cancellation stops
obsolete jobs from waiting for the runner. Step-level `always()` cleanup remains mandatory.
This follows [GitHub's cancellation guidance](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#canceling-workflows).
Do not treat a cancelled run or its skipped gate as successful validation of a deliverable head.

The runner deliberately reuses an existing macOS user. This is a trust decision, not an isolation
boundary: workflow code can access anything that user can access, including Home and Keychain
material. Temporary profiles, blocked Agent discovery, owner-scoped cleanup, and a clean checkout
prevent accidental inheritance; they do not contain malicious workflow code.

Only a same-repository PR authored, triggered, and retriggered by `tjx666`, a trusted
`release: v<package-version>` push to `main`, or an explicit owner-run validation can execute
repository source on this machine. Untrusted PRs run only the fixed final gate from the trusted base
workflow: it performs no checkout and fails closed. A trusted release push runs the one-worker
control E2E suite and Release.

An ordinary merge to `main` skips every job, including the final gate. The one runner is strictly
serial, and the merged head has already passed the same gate on its PR, so re-running it would only
delay the next PR without adding evidence. The `push` trigger stays because Release starts from a
successful CI run on `main`.

The downstream Release job runs only after the same release commit passes self-hosted checks and
the full Electron E2E suite. That job receives a short-lived `GITHUB_TOKEN` with `contents: write`
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
the exact Node 24 LTS version, while `pnpm/setup` installs pnpm 12 only when its versioned runner tool
cache is missing. The action reads the Bun version from `.bun-version`. These runner-owned paths do
not replace the user's interactive Node, pnpm, or Bun installations.

Node uses the standard Actions tool cache. pnpm and the Bun binary use versioned directories beneath
`RUNNER_TOOL_CACHE/caxri`; the Bun binary must match `.bun-version`, remains separate from `~/.bun`,
and the job fails closed if it is missing or stale. The pnpm store, Electron, ESLint, and Prettier
caches live under the same runner-owned root. The workflow does not upload these caches to GitHub.
Checks, E2E, and Release jobs that consume the dependency graph run a fresh frozen-lockfile install.
The retry-policy job intentionally uses only runner-pinned Bun and repository source while deriving
the execution plan. Cleanup removes workspace cache links without deleting runner-local toolchains
or cache contents.

The Release job also builds the Android update APK (`docs/mobile/UPDATE.md`), so the runner account
keeps the Android toolchain from `apps/mobile/README.md` installed: a JDK 17 in `JAVA_HOME` or the
Gradle JDK cache, and `~/Library/Android/sdk` with Platform 36, Build Tools 35.0.0 and 36.0.0, the React Native NDK
version, and CMake 3.22.1. The release signing key comes only from repository secrets and is
written to `RUNNER_TEMP` for the single build step. A missing toolchain or secret fails the release.

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

## Offline behavior

If `m2-24` is offline, unhealthy, busy, or under maintenance, every matching CI or Release job
remains queued until the machine returns. There is no hosted fallback label, runner input, billing
probe, or temporary workflow override. Do not treat a queued job as successful.

Because one physical runner owns all capability labels, jobs execute serially. The full E2E path is
one job that runs its two logical pools in sequence after one setup/build; checks, E2E, and Release
still cannot compete for the same workspace or native UI. This preserves one desktop owner while
allowing the explicitly isolated `parallel-safe` pool to use two namespaced workers internally.

## Validation and recovery

Before making the runner the normal PR target, freeze one exact head and record:

- three consecutive self-hosted full E2E runs with the same Node/pnpm/lockfile, profile, manifest
  hash, test count, and skip count;
- one complete self-hosted platform-check run and final `CI gate` on the same frozen head;
- one interrupted-worker run that fails while the following run starts with a free lease and clean
  profile;
- one offline run that remains queued and resumes only after `m2-24` reconnects;
- one dry release-path validation proving the `caxri-release` label, trusted workflow-run identity,
  clean packaged probe, and teardown without creating a tag or Release.

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

During replacement, keep normal CI and Release traffic held rather than leaving matching jobs
queued for an unvalidated listener. Local lint, typecheck, unit, build, or focused E2E results are
provisional local evidence; they are not GitHub checks, exact-head CI, or a reason to add a temporary
hosted fallback. If the capability labels must change permanently, review the workflow and its
contract tests as a separate repository change after the replacement is available.

To remove a healthy runner intentionally:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh stop || true
./svc.sh uninstall || true
./config.sh remove --token "$REMOVE_TOKEN"
```

Registration and removal tokens are one-hour credentials. Keep them in shell variables, never in
the repository, shell history, job summaries, or logs.
