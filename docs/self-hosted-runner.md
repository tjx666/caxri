# Self-hosted macOS E2E runner

## Scope and trust boundary

Caxri uses the repository-level `m2-24` runner only for trusted macOS Electron E2E. The runner
labels are `self-hosted`, `macOS`, `ARM64`, and `caxri-e2e`. Linux checks and the release workflow
remain GitHub-hosted.

The runner deliberately reuses an existing macOS user. This is a trust decision, not an isolation
boundary: workflow code can access anything that user can access, including Home and Keychain
material. Temporary profiles, blocked Agent discovery, owner-scoped cleanup, and a clean checkout
prevent accidental inheritance; they do not contain malicious workflow code.

Only a same-repository PR authored, triggered, and retriggered by `tjx666` can select the
self-hosted labels. Forks, other actors, pushes, and ordinary manual dispatches use
`macos-latest`. A `workflow_dispatch` can select `self-hosted` only for an explicit owner-run
validation.

Never add personal or production credentials to Actions secrets, job environment variables, or
E2E fixtures for this runner. Full E2E keeps Agent discovery `blocked`; specs that need an Agent use
only the repository fake fixtures and profile-scoped provider state. The manual real-Agent smoke is
not eligible for this runner workflow.

## Normal operation

Keep the Mac connected to power with the runner user logged in and the desktop unlocked. Before
service installation, run the listener in the foreground:

```bash
cd "$RUNNER_INSTALL_DIR"
caffeinate -dimsu ./run.sh
```

After the fixed-head validation matrix is green, install the per-user launchd service:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh install
./svc.sh start
./svc.sh status
```

The runner application updates itself by default. After an update, macOS or Xcode change, stop the
service and repeat one explicit self-hosted control validation before returning the runner to normal
PR traffic.

## Preflight and teardown contract

Every self-hosted E2E job:

1. verifies the trusted actor, repository, event, macOS/ARM64 runner, exact checkout head, clean
   workspace, and free repository desktop lease before installing dependencies;
2. assigns a bounded run owner to every inherited process and desktop lease;
3. isolates temporary files and provider state under the job's `RUNNER_TEMP` directory;
4. records runner identity, exact head, route reason, manifest hash/test count, timings, and cleanup
   status in the job summary;
5. terminates only processes carrying the exact run owner, reclaims only dead leases carrying that
   owner, removes only a matching marked temporary root, and fails if any lease or workspace change
   remains.

Cleanup failures are job failures. Do not replace owner checks with `pkill`, process-name matching,
or a broad temporary-directory deletion.

## GitHub-hosted fallback

If `m2-24` is offline, unhealthy, or under maintenance, add the
`ci:github-hosted-e2e` label to the PR. The `labeled` event cancels the queued run through workflow
concurrency and starts a replacement run attached to the same PR required check on `macos-latest`.
The job summary records the label route and exact head. Remove the label only after the runner is
healthy; `unlabeled` starts a new self-hosted run for a trusted owner PR.

Do not treat an offline queued job as successful, and do not modify the workflow temporarily to
simulate fallback.

## Validation and recovery

Before making the runner the normal PR target, freeze one exact head and record:

- one GitHub-hosted control run;
- three consecutive self-hosted full E2E runs with the same Node/npm/lockfile, profile, manifest
  hash, test count, and skip count;
- one interrupted-worker run that fails while the following run starts with a free lease and clean
  profile;
- one offline run that remains queued until the explicit fallback label creates a hosted run.

If unauthorized code ran, credentials may have been accessed, cleanup ownership cannot be proved,
or the machine shows unexpected credential access:

1. stop the listener or service immediately;
2. remove the repository runner in **Settings -> Actions -> Runners**;
3. preserve only content-free runner, Main, and Runtime diagnostics;
4. rotate credentials reachable by the macOS user, not only Actions secrets;
5. inspect and clear verified Caxri-owned processes, leases, worktrees, and profiles;
6. register a fresh runner token and repeat the full validation matrix before recovery.

To remove a healthy runner intentionally:

```bash
cd "$RUNNER_INSTALL_DIR"
./svc.sh stop || true
./svc.sh uninstall || true
./config.sh remove --token "$REMOVE_TOKEN"
```

Registration and removal tokens are one-hour credentials. Keep them in shell variables, never in
the repository, shell history, job summaries, or logs.
