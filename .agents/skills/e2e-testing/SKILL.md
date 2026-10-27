---
name: e2e-testing
description: Validate Caxri through focused Playwright Electron workflows, real PTY and IPC boundaries, native window lifecycle, E2E fixtures, production-build parity, error artifacts, and explicit full-suite CI routes. Use after changing user-visible Electron behavior, E2E infrastructure, Agent launch fixtures, desktop leases, or packaging-facing runtime behavior; when diagnosing a CI-only Electron failure; or when an explicit Go run needs its guarded exact-head fallback. Do not use as the default Vitest workflow.
---

# E2E Testing

Use the smallest real Electron workflow that proves the changed boundary.

Keep `playwright.config.ts` and its reporter-selection imports independent of workspace runtime
packages. Node/Jiti loads this configuration before those packages are built; a warm local build
can hide a broken import graph. Select reporters through
`scripts/reporters/public-e2e-reporter-policy.ts`, and verify configuration changes against the
pre-build Knip path as well as the focused log-safety contracts.

## When a behavior earns an Electron workflow

E2E specs launch a real Electron app under the repository desktop lease, so each spec is expensive.
Reserve them for failure modes that cannot exist below the desktop boundary:

- A user-visible flow spanning process boundaries (Renderer → IPC → Main/Runtime → back into the
  UI), where every layer can pass its unit tests while the wiring between them is wrong.
- Native desktop capability with no faithful mock: window lifecycle, native menus, focus, keyboard
  shortcuts as wired, and a real PTY running real processes. Native dialogs are the exception
  below.
- Persistence and recovery across a process restart: Session/layout/Terminal restore, Runtime
  crash and reconnect. The restart itself is the behavior under test.
- A small set of critical-journey smokes (launch → Project → Session → Terminal/Agent) whose
  failure means the product does not work at all.
- A regression test for a bug whose root cause was integration-level (preload contract, packaging
  difference, CSP, event ordering); a unit-level test would not have caught it and will not guard
  it.
- Pure UI interaction contracts (drag, tooltips, keyboard navigation): `.tsx` components are never
  unit-tested, so E2E is their only verification surface. Assert what the user can accomplish, not
  pixels or styling.

Everything else (pure computation, store state machines, invalidation predicates, protocol
schemas) belongs to `unit-testing`. Before writing an E2E spec, ask whether the logic can be
extracted below the boundary and tested there; if yes, extract it instead.

## Pool classification

A new spec joins CI's three-worker `parallel-safe` pool by default. When it holds the system
clipboard, a visible window or GPU, OS window focus (a two-keystroke chord, `document.hasFocus()`
attention), a wall-clock assertion such as a 4s toast it must catch, or machine processes, add it to
`desktopExclusiveSpecs` in `e2e/support/pools.ts` with its reason in the same change. The reason
enum, admission conditions, and the contract test that derives `clipboard: true`,
`windowMode: 'visible'`, and `gpuMode: 'enabled'` from spec sources live there; split a spec when
only some of its tests need the exclusive pool.

## Focused workflow

1. Finish source edits and focused `unit-testing` coverage first when both layers apply.
2. Run only the owning spec and test name through the compact checker; it rebuilds first so the
   Electron launch cannot exercise stale output:

   ```bash
   bun run --silent check <e2e-file> --e2e --e2e-grep '<test name>'
   ```

3. Every spec imports `test` and `expect` from `e2e/support/fixtures.ts`. The automatic error gate
   observes current and future Renderer pages, error notifications throughout each document's lifetime,
   structured Main/Runtime errors, and attaches
   content-free logs before temporary profiles disappear.
4. Focused launches use hidden windows. Use `windowMode: 'visible'` only for native focus or
   pointer behavior. Every launch acquires the repository-wide desktop lease through
   `e2e/support/helpers.ts`. Visible native work must also follow the lease's
   [human-focus boundary](../switch-worktree/SKILL.md#serialize-desktop-work): prepare the exact
   action before choosing visible mode and launching, then stop the owned launch before diagnosing
   an unexpected result. A hidden window reaches window presence as visible only through
   `isUnshownWindowVisible` in `apps/desktop/src/main/window-presence-registry.ts`, and the Server
   starts the Files watcher and Project Status polling only for a visible Session. A change to
   presence or visibility gating must run `e2e/startup.performance.e2e.ts`, which waits for Files
   and Git readiness; unit tests and other specs stay green while the watcher never starts.
5. Ordinary launches use blocked Agent discovery. Agent specs explicitly choose a shared fake mode;
   policy tests named `real` may still use a synthetic executable and do not authorize host provider
   discovery. Only the manual Codex-only real smoke below invokes the installed Codex CLI.
6. A deliberate error must consume one exact `allowE2EErrors(...)` tuple. Wildcards, message
   matching, duplicate allowances, or unused allowances fail the spec.
   Error notifications use `{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: N }`.
   Count mounted error notifications: a deduplicated update of the same notification counts once,
   while a new notification after dismissal counts again. The gate retains observations after
   auto-dismissal, navigation, and window closure without recording notification text. Declare
   this allowance alongside any separately expected console or backend errors; an end-of-test
   zero-toast assertion cannot replace the continuous gate.
7. Make visual regressions observable rather than asserting only that an element exists. For
   Terminal inset or background coverage, use contrasting application and Terminal theme colors so
   uncovered pixels cannot pass unnoticed.

For Monaco typing, reuse the existing spec pattern that clicks the visible `.monaco-editor`
surface. Do not assume a textarea or clickable textbox: EditContext can expose a zero-size input.
When capturing a modal handoff, wait for the outgoing popup to unmount; the incoming dialog being
visible does not prove its predecessor's exit animation has finished.

## Scripted launch

Use the launch helpers instead of the developer's real profile:

- Native macOS dialogs are manual verification boundaries by default. Stub `dialog.showMessageBox`,
  `dialog.showOpenDialog`, or `dialog.showSaveDialog` in Main and assert the resulting product
  state; never trigger or drive system UI from an E2E spec. Only a current user request explicitly
  asking the agent to verify a native dialog permits the guarded Acceptance exception.
- `CAXRI_E2E=1` enables unpackaged test-only boundaries.
- `CAXRI_USER_DATA_DIR=<tmpdir>` isolates Electron user data.
- `CAXRI_TEST_ROOT_PATH=<dir>` supplies one deterministic folder-picker root only when
  `CAXRI_E2E=1` is active.
- `CAXRI_TEST_ROOT_PATHS=<JSON array>` queues deterministic roots for multi-Project workflows.
- Shared helpers default Agent discovery to `blocked` and isolate provider state beneath test user
  data. Agent specs explicitly select shared `fake` mode or the single-provider `real` mode, except
  negative tests that deliberately prove the `blocked` default; never inherit the developer's
  `PATH`, `HOME`, `CODEX_HOME`, or `CLAUDE_CONFIG_DIR` accidentally.
- Fake Agents pick their scenario by substring keywords in the sent message, listed in the header
  of `fake-codex-app-server.ts`, `fake-claude-cli.ts`, and `fake-grok-acp.ts` under
  `apps/server/src/domains/agent-chat/__tests__/fixtures/`. Check free-form message text against
  that list: "It fails on CI" contains `fail`, so the fake Codex turn fails instead of replying.
  A spec that needs a specific multi-step turn instead passes a scripted-turn file through the
  fixtures' `scriptPath` option (`fake-claude-script.ts`, `fake-codex-script.ts`); a message equal
  to a scripted prompt bypasses the keywords.
- A fault-injection environment flag must reach the process that owns the seam. Cover Desktop to
  Server forwarding with a boundary test and verify the controlled delay or failure occurs before
  interpreting the product assertion; setting the launcher environment alone is not proof.
- Seed Home-browser fixtures under the launcher's isolated Agent HOME
  (`<userDataDir>/e2e-agents/home`); a `launchCaxri({ env: { HOME } })` override is replaced by
  the isolation environment. Canonicalize expected Project roots before comparing server results.
- Guarded Android Acceptance reserves up to two minutes for the shared Desktop lease after its
  release build. Keep that queue budget separate from the scenario deadline; a busy sibling must
  be awaited through the lease API, never killed or bypassed, and must not force an immediate APK rebuild.

The manual real-Agent smoke is Codex-only: `bun run test:e2e:real-agent`. It requires an
authenticated Codex CLI, disables screenshots and traces, and never falls back to another provider.
Its PTY case sends one bounded read-only prompt through `codex exec` in a temporary Project. Its Chat
case runs under a Chat-only real policy (read-only sandbox, no approvals, no Terminal launches),
sends two short natural prompts across a relaunch, and asserts only content-free signals (statuses,
item counts, `thread/resume`, unchanged thread id); see `docs/agent-chat.md`. Run one case with
`-g Chat` to avoid spending a second real turn.
It never runs through the ordinary focused checker, full suite, CI, or Acceptance. Provider-owned
input protocols may also use the `debug` skill's controlled real-Codex probe; that remains diagnostic
evidence rather than automated test or Acceptance evidence.

## Readiness and failure-isolation contracts

- Use `createProjectSession` / `waitForCreatedSession` so dialog removal, selected Session,
  durable Session/Terminal state, visible Session card, and focused Terminal converge together.
- A fake Agent publishes its ready marker only after raw mode and input capture are installed.
  Wait for that marker before sending bytes; never use a sleep as readiness.
- For Terminal resizing, wait for repeated identical guest/Runtime grid observations and compare
  them with the rendered xterm grid. Extra intermediate `SIGWINCH` values are valid.
- Place cursor-addressed fixture text inside the smallest grid used by the test. Assert it immediately
  after a viewport shrink before attributing later missing text to Session restore.
- Treat only an expected transient filesystem `ENOENT` as pending. Propagate permission, malformed
  data, and other IO errors immediately.
- An `expect.poll` callback must return a pending sentinel for an expected transient state instead
  of throwing. Use `e2e/support/polling.ts` only when callback errors are explicitly classified as
  retryable; its timeout keeps the most recent callback error in the failure text.
- An assertion that already holds before the awaited work happens is not a wait. Counting cards,
  checking visibility, or reading the first row all pass in both the ready and the not-ready state,
  so the spec proceeds one step early and only loses the race on a loaded runner. Wait on the value
  that separates the two: capture the identity the mutation returned and assert the UI carries it,
  as `session-list-window.e2e.ts` does with `data-session-id` before it sends a key.
- A new tab can render before it becomes active. For remount or recovery assertions, wait for the
  old surface to unmount or for a verified attach/reload before performing the next action; tab
  presence alone does not establish the lifecycle boundary.
- Keep drag-test receipts outside watched Project roots; a previous assertion must not trigger a
  tree refresh that moves the next pointer target.
- Do not mutate the filesystem while a menu, popover, or other transient surface is open. A watched
  filesystem event refreshes the Files tree, which can re-render the very row the open menu is
  anchored to and make its items unreachable for the full click timeout. Change permissions or
  contents first, then open the surface; see the comment in `error-toast-recovery.e2e.ts`.
- Match Terminal text across rendered rows when long CI paths or narrow panes can wrap it. Do not
  assume a logical token belongs to one DOM row.
- Publish repository and desktop ownership only after complete owner metadata is durable. Await
  launch finalization and lease cleanup so one worker failure cannot poison later specs.
- Preserve the first causal failure, its content-safe Actions log, and its public receipt. Do not use
  retries to turn an original red result green or allow a lock/lease cascade to hide it. The one
  exception is `e2e/startup.performance.e2e.ts` in the `release-packaged` and `release-rehearsal`
  pools: it may retry once because hosted-runner jitter alone has failed its 3 s budget. The receipt
  keeps the first attempt as `firstFailure`, the run shows a `Flaky E2E pass` warning, and each such
  pass is recorded on issue #1418. `scripts/__tests__/e2e-retry-exception.test.ts` rejects any other
  spec or pool that configures retries.
- Map a CI failure to the repository-relative location and closed status in that run's public log,
  plus the receipt's spec and stable error classification, before naming the failed stage. Inspect
  the assertion text only from the checked-out source or a focused local reproduction; the public
  reporter deliberately omits titles, errors, snippets, stdout, and stderr. Remote Playwright
  screenshots and traces are not public diagnostic evidence.
- CI keeps `maxFailures` for fast containment, then reruns suppressed tests once per file and line with
  `--max-failures=0` so every parameterized sibling receives a verdict.
  The final pool receipt must classify every planned spec as `pass`, `fail`, or `timeout` and group
  repeated failures by stable error identity before repair begins.
  A `passed` receipt does not by itself prove a green pool: every child must also exit zero and
  every dispatched spec must reach the receipt, or the runner marks it `failed` with
  `abortedInvocations` / `missingSpecs`. A sibling `checks` failure (or the shared 25-minute
  concurrent-validation deadline) can also `SIGTERM` a pool mid-run; `run-e2e-pools.ts` survives long
  enough to write a partial receipt with `abortReason` (`SIGINT` | `SIGTERM`) instead of losing
  whatever already failed, distinguishing specs that finished, the invocation the signal actually
  killed (`abortedInvocations`), and specs that never ran at all (folded into `missingSpecs`); see
  issue #1446. The killed invocation's settled verdicts survive through the reporter's
  `<receipt>.progress.jsonl` journal (issue #1847).
- An interrupted local pool leaves Electron and Playwright processes behind. Clear them with
  `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts stop`, never with a name match:
  `pkill -f "Caxri.app"` also matches the installed `/Applications/Caxri.app` and has already
  terminated it mid-session during exactly this cleanup.

## CI-only parity

Reproduce only the exact failed cases against the production build with one worker and two
deterministic repetitions:

```bash
bun run build
bunx playwright test <failed-files...> -g '<failed test>' --workers=1 --repeat-each=2 --reporter=line
```

When one local command launches more than one Electron instance, wrap the entire command in the
worktree desktop coordinator. Holding the coordinator across every repetition prevents a sibling
worktree from acquiring the root lease between Playwright launches:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts desktop --label focused-repeat -- \
  bunx playwright test <failed-files...> -g '<failed test>' --workers=1 --repeat-each=2 --reporter=line
```

Preserve the relevant CI viewport, font/locale/shell behavior, and long temporary-path conditions.
Inject slowness at the owning async boundary or wait for an observable product invariant. Never use
machine-wide throttling, fixed sleeps, random pressure, or a timeout-only change as the fix.

If every CI-failing case passes two deterministic local repetitions, CI's failure is waived for this
delivery: stop investigating it here. This holds whether or not the case covers the changed
behavior. When it does, the delivery's own focused specs must also pass two repetitions in the same
round. Preserve the case, CI run and
failure evidence, local reproduction command, result, and whether the case touches the changed
behavior for
[issue #1418](https://github.com/tjx666/caxri/issues/1418), then continue delivery. Create or update
that remote record only when the current request or an active delivery workflow authorizes issue
mutation; otherwise include copy-ready evidence in the local report. Search existing comments first
when publication is authorized, and append a new occurrence to the matching case comment instead of
creating another comment for the same test.

Two repetitions are the entire local budget, and they cover the related cases only: the failed CI
cases plus, when they touch the changed behavior, the delivery's focused specs. Repairing CI never
runs the full unit or E2E suite locally, and never keeps re-dispatching CI, to decide whether a case
is intermittent. A local full run occupies the machine the user is working on; only the user's own
explicit request authorizes one. A `hosted-full` dispatch is also never inferred from risk, failure,
or another agent's verdict: every run or retry requires fresh, explicit maintainer authorization.
Hosted runs are metered while the repository is private. Repair from the preserved first failure
and the #1418 record instead of redispatching until the cause is addressed.

CI publishes only content-safe JSON receipts for failures. Its `public-e2e-reporter.ts` console
reporter prints bounded locations, statuses, durations, counts, and run state while dropping titles,
errors, source snippets, worker stdout/stderr, DOM values, and Terminal values. Playwright
screenshots, traces, DOM snapshots, and raw Main/Runtime logs remain on the disposable runner and are
never uploaded. Keep the failed CI run red while diagnosing it.
Use a distinct `CAXRI_E2E_OUTPUT_DIR` for each local reproduction and verification round when comparing
failures; Playwright clears its output directory at startup, including a preceding pool's evidence.

A failed pool's `e2e-<pool>-failure-artifacts` CI artifact carries only the validated pool receipt
(`test-results/public-receipts/<pool>.json`). `.github/workflows/ci.yml` owns the exact receipt-only
upload step per pool. A pool that concurrent validation aborted before its turn has no receipt and
uploads nothing. Auxiliary E2E files remain only inside the disposable runner; the Actions log keeps
their bounded step outcome, and there is no auxiliary artifact upload.

**Public CI evidence boundary (issues #1446 and #2118).**
`scripts/prepare-public-e2e-receipts.ts` reads only the fixed internal receipt filenames, validates
their closed schemas, strips titles, test IDs, artifact paths, timestamps, and arbitrary error text,
then atomically writes the public projection. A public pool receipt contains only closed verdicts,
counts, durations, root E2E spec paths, stable error hashes (or a closed `missing-error`
classification), and abort metadata. Workflow upload steps depend on that preparation succeeding and
name each public JSON file exactly: no directory or glob is an allowed upload path. Never upload a
Playwright output directory, `trace.zip`, screenshot, video, `error-context.md`, or raw `.jsonl` log:
path redaction does not remove embedded repository source, DOM snapshots, Terminal input, or Terminal
output. When a failure needs that deeper evidence, reproduce only its exact cases locally and inspect
the local output before the worktree-owned process is stopped.

### Diagnosing an error-gate notification

`toast categories:` in a gate failure names the notification's product copy, never its cause. Read
the cause out of the retained logs instead of guessing from the category:

1. Read the failed spec and stable error identity (or `missing-error` classification) from the public
   pool receipt, use the Actions log only for its bounded location/status, then inspect the assertion
   from the same checkout and reproduce only that case locally with a distinct
   `CAXRI_E2E_OUTPUT_DIR`.
2. Open the locally generated `caxri-desktop-*.jsonl` and `caxri-server-core-*.jsonl`, then line up
   the notification against `ipc.request_failed` entries by timestamp. A pairing gives the
   request name and error code behind the notification: that is how a `terminal.activate`
   notification was traced to a `NOT_FOUND` on `session.updateState`.
3. No pairing is evidence, not a capture gap. The gate says so in the failure text. Only two
   sources produce a notification with no logged error: a Renderer-local failure, and a request
   refused after quit began, which `apps/desktop/src/main/workbench-ipc.ts` deliberately does not
   log because a cancellation at quit is an expected outcome. Check the Renderer's own handler for
   that copy before assuming the log is incomplete.

A loaded-runner reproduction belongs to that collective work rather than to this delivery. A
`parallel-safe` race can need the repository-owned namespaced two-worker pool to appear at all,
because loaded-runner conditions expose stale async state and hidden warmup surfaces that one worker
cannot reproduce. Run that pool while repairing the recorded case, not as a gate on the delivery
that reported it. It is a full-pool run, so it runs only when the user explicitly asks for it
([Remote full suite](#remote-full-suite)):

```bash
bun run build
CAXRI_E2E_PARALLEL_WORKERS=2 bun run scripts/run-e2e-pools.ts --pool parallel-safe
```

Build first and leave the worktree alone until the pool ends; editing a source mid-run trips the
build-freshness guard and turns unrelated specs red with `Error: Build output is stale`. Running
`check` or committing (lint-staged rewrites staged files) trips it the same way. This holds for
every E2E run in that worktree, including a focused `check --e2e` in the background: do only
read-only or remote work meanwhile, and stage patches outside the worktree until it ends. Prefer
stable observable locators and explicit busy-to-ready transitions over arbitrary delays.

The waiver covers only a recorded case that passed both local repetitions. A case that fails
locally in either repetition, and a case nobody reran, still block delivery. Recording a failure
never replaces the validation that covers the changed code.

Collect CI comparison evidence through the repository-owned workflow dispatch instead of an ad-hoc
command.
`docs/ci-performance.md` owns the current profile, pool, receipt, and comparison contract; use the
following controls when collecting a new comparison:

- Select the documented control or optimized profile through `e2e_profile`; do not reproduce its
  pool orchestration with an ad-hoc command.
- Workflow dispatches run deterministic CI-parity cases through `scripts/run-ci-parity.ts` and
  preserve the profile receipts defined by the authority document.
- Follow the authority document's frozen sample count, dispatch order, non-green treatment,
  adoption threshold, and stop condition. Do not extend a declared experiment until it becomes
  green or replace a red sample outside its documented infrastructure-failure rule.

## Explicit full-E2E retries

Ordinary PR and main-push CI never starts Playwright E2E. The legacy `CI-Mode: e2e-only` and
`CI-Mode: e2e-repair` trailers remain parseable only as compatibility metadata: they run full hosted
checks, cannot start E2E, cannot reuse an ancestor E2E receipt, and must not be added to new PRs.
`CI-E2E-Tests` records the affected spec set for review but is not an execution receipt.

When an explicitly authorized `hosted-full` run fails, preserve its Actions log and receipts and
reproduce the exact failed spec against a fresh production build with the focused command above.
Do not push one repair per observed assertion. Inspect the whole failed spec and its async/locator
assumptions, finish the repair batch locally, then create one new exact candidate. Dispatch the
explicit full route again only after its focused local evidence passes and the maintainer grants
fresh authorization for that retry.

## Remote full suite

Never run `bun run test:e2e` locally during an ordinary run. The command enforces this itself:
`bun run test:e2e`, a bare `playwright test`, and every `scripts/run-e2e-pools.ts --pool` refuse to
start without authorization, before the desktop build runs. The user grants it by setting
`CAXRI_FULL_SUITE_AUTHORIZED=1` only when they explicitly ask for a local full run; an agent never
sets that variable on its own judgement or on a subagent's or another harness's verdict, including
while repairing CI. GitHub Actions is authorized by its own `CI` variable. When focused coverage is
insufficient, use an authorized topic branch and PR. A ready PR records affected specs: declare
cases the import graph cannot infer with one `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line in the PR
body. Pull requests and main pushes run hosted checks but never start full E2E automatically. While
preparing the repository for publication, the required evidence is the complete hosted
unit/integration suite, build and native checks, package validation, targeted Electron smoke, and
the hosted no-publish Release rehearsal. Full E2E is deliberately not a runner-removal, GO,
repository-publication, Release, or anonymous-review gate. `hosted-full` remains a future manual
route on `macos-15`; every dispatch or retry requires fresh, explicit maintainer authorization
([docs/ci-performance.md](../../../docs/ci-performance.md)). It still runs the fixed Renderer
performance scenario and uploads a receipt. The historical cross-run baseline stays unarmed and
non-blocking until enough same-image hosted receipts are reviewed, and the manually dispatched trend
comparison is not a gate during that calibration. Inspect failures, repair the same branch, and wait
for the authorized replacement checks. Do not merge or close without delivery authorization.

Use `bun run --silent test:smoke` for the cheap post-change Electron launch gate when broad desktop
startup confidence is useful but focused product E2E is unnecessary. Hosted launch and packaged
Release smokes that do not request clipboard access use the fail-closed
`CAXRI_E2E_CLIPBOARD_PROTECTION=skip-hosted` override, excluding cold Swift/AppKit preparation on a
disposable runner. Local focused runs still preserve the clipboard. A future smoke that needs
clipboard access must remove that override and declare the capability. Keep implementation
subagents scoped to explicit specs and test names; never delegate the full `bun run test:e2e` gate.

## Guarded Go fallback

Use a local full-suite substitution only inside an explicit Go run after a current-head Actions job
is verified to have failed before execution for an eligible external GitHub Actions infrastructure
reason and the user separately authorizes the substitution. The Go ledger must record the exact
frozen head, failure URL/job/detail, authorization, platform-check commands, and one `bun run
test:e2e` result. A changed head invalidates the admission. Code/test failures, missing
authorization, releases, and deployment are never eligible, and the Actions check remains
externally failed rather than being relabeled green. This generic fallback does not authorize a
`hosted-full` dispatch or retry; each of those still needs fresh maintainer authorization.
