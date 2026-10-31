---
name: acceptance
description: >
  Verify Caxri deliveries on the real macOS Electron desktop, `caxri` CLI,
  Android, and iOS Simulator product surfaces; capture visually inspected
  evidence; and publish immutable review rounds with the LobeHub CLI, or render
  them as a local offline report when not signed in. Use when
  Caxri work must prove user-visible behavior, generate an acceptance report,
  respond to acceptance feedback, or re-verify a repair.
---

# Caxri Acceptance

Builders may produce delivery evidence, but only a separate human review may accept or reject it.
Choose `desktop`, `cli`, or `mobile` per planned claim: the surface whose user-visible outcome the
check asks a reviewer to decide. Use `cli` only when the outcome is what a `caxri` command prints or
changes; a command run to set up a Renderer check is setup, not the check. Use focused tests, build
output, logs, or probes as supporting evidence, never as substitutes for the real product surface
when the claim is user-visible. A cross-surface workflow may use several surfaces, but each check
names exactly one.

## Decide whether to execute before starting a round

Creating or updating a PR, marking it ready, or being asked to upload a report must not by itself
start another verification run. First inspect the requested scope and the task's existing reports,
evidence, published Acceptance links, and local `report.html` pages (from the conversation, the PR,
or `.records/acceptance/`).

| Delivery state                                                                         | Action                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation or instruction-only change, or refactor/tooling with no behavior change  | Skip product acceptance and briefly state why. Keep the applicable quality checks.                                                                                                |
| A published Acceptance still covers the delivery                                       | Reuse its URL and coverage. Do not create a round or rerun cases just for the PR.                                                                                                 |
| A locally rendered `report.html` still covers the delivery                             | Reuse it. When others must now review it, publish the existing rounds ([local reports](references/report.md#render-locally-when-not-signed-in)); never rerun cases to share them. |
| A finalized round and its evidence exist locally, unpublished, and still cover it      | Inspect coverage and artifacts, then publish that round. Preserve its execution provenance; no rerun, new plan, or repeated checker review.                                       |
| The delivery was already exercised on the real product in this session, no report yet  | Write `plan[]` and `cases[]` from the observations made, attach the original artifacts, disclose any required medium never captured instead of recapturing it, and publish.       |
| Product behavior lacks valid evidence, or relevant behavior changed after verification | Execute only the missing or affected outcomes and retain unaffected evidence with its original provenance.                                                                        |

Evidence is reusable when its criteria cover the requested behavior, its artifacts are available
and support the observations, and later code, dependency, configuration, or environment changes do
not invalidate them. A different commit SHA, rebase, PR event, or publication status alone is not a
reason to rerun. Failed or blocked checks and missing required evidence are not passes: repair or
supplement those specific gaps. An explicit user request for fresh verification still wins.

## Independent acceptance review (first round only)

The primary checks the environment, writes the plan, executes cases, inspects
evidence, repairs failures, and publishes. Use one `acceptance-checker` agent at two points
in the first acceptance round: give at most two feedback responses on the plan and cases
before execution, then perform exactly one quick report/evidence check against
the agreed criteria before publishing. A second plan check is optional, only
to check the primary's revisions; there is no third plan-feedback response.
Count the two stages separately. After
either stage's limit, the primary owns remaining corrections and verification.
The acceptance-checker **is** the plan gate: never ask the user to approve a
plan; ask the user only for a user-owned prerequisite or a product decision
that changes the plan. In both stages, the primary supplies an explicit file
list and the relevant diff text or prepared diff artifact paths. The acceptance-checker
limits code reading to these materials; it must not run `git diff` or discover
its own scope. This does not restrict inspection of the plan, report, or evidence.
During evidence review, use it only to identify the updates and the agreed
cases whose evidence needs checking; the core task is checking the report
against the plan and artifacts. Do not reopen requirements, expand into code
review, or investigate implementation details. Return contradictions to the
primary for explanation or repair. Follow-up rounds have no acceptance-checker: the primary
re-runs, inspects, and publishes itself. Do not delegate execution or require
per-case approval.

Read [references/acceptance-checker.md](references/acceptance-checker.md) for the input/output
contract, review boundaries, and follow-up rules. Acceptance review supplements the
primary's own checks and `deep-review`; it does not replace either. Spawn it with this harness's
own subagent controls and keep it read-only: it never launches Electron, never attaches to CDP,
and never holds the desktop lease. If delegation or required media inspection is unavailable,
disclose the missing review and unverified claims rather than claiming independent acceptance.

The acceptance-checker runs both stages: the plan gate before execution and the final evidence
stage before the first round is published.

## Programmatic gates are not acceptance checks

Every check is an outcome a **person decides about the delivery**: what the
user sees, hears, reads, or receives. These never appear as a check, under any
phrasing: unit / integration / regression / snapshot tests, coverage,
`type-check` / `tsc`, lint / `eslint`, format, "compiles", "build passes",
"CI is green". Run them, then report them as **one line of narrative**.

Reject any matching item before freezing the plan, including a product-sounding
title whose `method` says to run `bun run check`. Do not rely on a downstream
publication service to remove, reinterpret, or recount invalid checks. The line
is the _subject_ of the check, not who judged it: a Terminal behavior asserted
by a command is a fine check (`verifier: "program"`); "the suite is green" is
not. Before writing any plan, ask of each draft check: _would the user click
accept/reject on this?_

## Rules you will be tempted to skip

| Excuse                                                    | Reality                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Injection is hard; happy path plus unit tests covers it" | The error state was the goal. Search `.agents/acceptance/probe-mock-patterns.md` for a way to force it before marking the case `blocked`.                                                                   |
| "The black frame is probably a permission or timing"      | Measure first: pixel brightness, the permission bit, an A/B with one variable toggled. Publish "confirmed by X" or "suspected", never a guess.                                                              |
| "The fix is in and tests pass, so it is verified"         | Reproduce the failure's precondition first, then verify with it held. A run that cannot fail proves nothing, and "reproduces sometimes" means an unnamed precondition. When a mock is the suspect, drop it. |

Use the installed `lh` as the CLI reference: consult a subcommand's `--help` only when its syntax or
capability is unknown, and reuse what you learned across stages instead of walking the whole help
tree or invoking a write command to probe support. A zero exit code or parseable JSON alone does
not establish publication or complete coverage; inspect structured errors and ingest warnings.

## Boundaries

- Exercise Caxri in an isolated Electron instance. Never drive the developer's resident app or real
  user-data directory.
- Acceptance forces Agent discovery to `blocked` unless the frozen case plan declares a
  repository-owned fake Agent fixture. Pass that exact fixture id to the launcher; arbitrary
  executables, environment authority, and host Agent providers remain forbidden. Never capture real
  Agent Terminal output or transcripts. The manual real-Agent smoke and the `debug` skill's
  controlled probe are supporting workflows, not Acceptance evidence.
- Select every mobile target explicitly. Never use an ambiguous `booted` Simulator or implicit ADB
  device after selection, never erase a user-owned Simulator, and never clear, uninstall, lock,
  unlock, reboot, or stop a physical device unless the current request explicitly authorizes that
  exact action. Acceptance cannot bypass a device lock screen or OS trust prompt.
- Treat pairing links, QR codes, keys, tokens, visible Terminal output, Agent transcripts, Session
  names, Project paths, and raw mobile accessibility trees as private. Do not capture or upload
  them. Use the repository's sanitized semantic and result receipts instead.
- A resident Caxri dev app is normal and must remain usable. `start-electron.ts` gives each
  Acceptance launch its own temporary macOS app bundle identity; never ask the developer to stop
  their app or fall back to global app-name, frontmost-window, or coordinate targeting.
- `start-electron.ts` fails immediately when another desktop task holds the repository desktop lease.
  When that task is expected to finish soon, pass `--lease-wait <seconds>` (integer 1 to 1800) so the
  launcher waits for the lease once and starts a single instance. Never write a shell retry loop
  around the launcher: it can relaunch an instance after cleanup. Input validation (build receipt,
  case plan, test roots) runs before the wait, and a timeout reports the current owner and the waited
  duration.
- Tell the user immediately before launching because the real desktop window can take macOS focus
  during verification.
- Follow the desktop lease's
  [human-focus boundary](../switch-worktree/SKILL.md#serialize-desktop-work). Before calling
  `start-electron.ts`, resolve every fixture input, artifact path, interaction, expected result,
  and cleanup command for the current case. Once the launch begins, do not look up tool schemas or
  CLI help, author scripts or evidence, or take exploratory captures. React to the adapter's
  `status: ready` receipt without adding a fixed post-readiness wait. Read-only CDP work must not
  call `Page.bringToFront`, `Target.activateTarget`, synthesize input, or otherwise reassert the
  app. A deliberate frontmost interval contains one pre-authored native interaction, its capture or
  readback, and immediate dismissal. On the first observation that does not match the pre-authored
  expectation, close the owned native UI and stop the owned launch before investigating.
- Use CDP and `agent-browser` for Renderer interaction and live inspection. Capture settled
  Acceptance screenshots with `capture-renderer.ts screenshot --output <path>` so the owned
  runtime, exact target, and output argument are validated. Use OS capture only when the criterion
  is specifically about Electron or macOS chrome that CDP cannot see.
- Bootstrap every isolated Project with the default `CAXRI_TEST_ROOT_PATH` fixture. Native macOS
  dialogs are manual Acceptance boundaries by default: do not trigger, inspect, click, record, or
  retry one. Stub Main's dialog result for automated coverage and hand dialog-specific checks to
  the user. Only a current user request that explicitly asks the agent to verify a native dialog
  permits the fail-closed exception in
  [references/native-dialogs.md](references/native-dialogs.md); general Acceptance or
  complete-real-path wording does not.
- Read every screenshot or recording before citing it. A file existing is not evidence that the
  expected UI rendered.
- Keep focused regression tests, lint, type checks, builds, and CI status separate from acceptance
  checks. They are delivery preconditions and may appear as one narrative line; acceptance checks
  are outcomes a person can accept or reject.
- Keep evidence at the user-observable boundary. Do not use repeated injections,
  screenshots, or timing guesses to claim an internal callback order that the UI cannot expose;
  prove the visible before/after outcome on the selected surface and use the smallest focused test or log
  receipt for the internal ordering contract.
- Simulator and emulator captures can prove layout, navigation, touch semantics, pairing, and
  bounded replies. They cannot prove physical-device thermal, energy, haptic, camera, radio, or
  release-performance quality. Name those checks as physical-device work or mark them `blocked`.
- Do not call `accept` or `reject` as the builder.

## Prepare

1. Read `.agents/acceptance/PROJECT.md` for the exact build, isolated launch, stop, CDP, and
   logging commands. Then read
   [`.agents/acceptance/common-mistakes.md`](../../acceptance/common-mistakes.md) before planning
   the round, load the matching project field notes indexed by `PROJECT.md`, and search
   [`.agents/acceptance/probe-mock-patterns.md`](../../acceptance/probe-mock-patterns.md) before
   authoring a new probe or mock. Fix adapter drift when observed. Before asking the user about an
   environment or fixture failure, search `.agents/acceptance/` for the exact error; ask for the
   missing prerequisite only when it records no fix.
2. Run `lh acceptance preflight --json` before writing plan or report text. Its `mode` says
   whether rounds publish (`publish`, signed in) or render locally (`local`, never signed in; see
   [local reports](references/report.md#render-locally-when-not-signed-in)). On a signed-in machine
   an auth error means stop and surface it, and its `language.locale` is the report language the
   account enforces at ingest. Caxri reports are Simplified Chinese, so stop and report a mismatch
   when the locale is not `zh-CN`; a `local` run reports the language `unset` and still writes
   Simplified Chinese. Pass that language to any subagent you delegate to, including the
   acceptance-checker. On a CLI without `preflight`, fall back to `lh whoami --json`; do not guess
   an `auth status` subcommand.
3. Resolve the immutable one-sentence business requirement for the whole acceptance. Write it in
   Simplified Chinese. The scaffold freezes it in the acceptance root so every later round must
   reuse the exact same requirement.
4. Author `plan[]` before testing. Give each check a stable id tied to the owning GitHub issue and
   declare its `surface` (`desktop`, `cli`, or `mobile`), expected behavior, required evidence, and
   `stateIsolation`. The scaffold defaults omitted surfaces to `desktop` and every case to
   `isolated`; use `readonly_checkpoint` only for an explicitly immutable checkpoint,
   and use `restart` only with one named profile whose final launch owns cleanup. Write all
   human-facing report prose in Simplified Chinese; keep machine ids, code identifiers, branches,
   commits, commands, and artifact paths in English. For every temporal check, name the observable
   start marker, end marker, and stop condition before launching. If the claimed ordering has no
   observable product marker, split the evidence into a user outcome and a focused supporting
   contract instead of starting an open-ended experiment. A case that changes UI users already
   see (copy, labels, toasts, layout, or style) requires a before/after `comparison` pair of the
   same view on the pre-change and delivered code
   ([references/report.md](references/report.md#before-and-after-evidence)); an after-only
   screenshot cannot show what it replaced. UI with no prior state is exempt. A desktop case that
   imports a theme or must show update UI declares `themeImportFixture` or `updateFixture`; the launcher arms Main
   fixtures only from these declarations
   ([references/report.md](references/report.md#initialize-from-the-frozen-plan)).
   Every mobile item also declares `mobileDevice` with `platform`, exact `deviceId`, and
   `appId: "com.caxri.mobile"`; finalization requires a matching
   `assets/<case-id>-mobile-device.json` receipt bound to the frozen commit and declared isolation
   identity: the final lifecycle launch, or the frozen checkpoint id for `readonly_checkpoint`. A
   cited `assets/<case-id>-result.json` receipt must carry the same identities. Every cited mobile
   screenshot or recording must also appear in the device receipt's `artifacts` array with its
   exact relative path, SHA-256, media type, and platform framebuffer source.
   Group the checks by the independently reviewable user tasks in the requirement, not by the PR
   title or the test surface. When acceptance depends on a sequence of user states, publish that
   graph during planning following [references/flow.md](references/flow.md); it is optional and
   never replaces evidence or human review.
5. Gate the first round's plan through an independent reviewer before executing: the
   acceptance-checker. Freeze the agreed plan after resolving its material findings. That decision is the plan gate; do not ask the user
   to approve the plan.
6. Run the report scaffold's `init` command with the frozen plan. It creates a fresh round
   directory containing case placeholders, `report.md`, `proposal.md`, and `assets/` under
   `.records/acceptance/<timestamp>/round-<n>/`. Replace the `proposal.md` placeholder with this
   round's note to the reviewer: ingest posts it into the acceptance discussion, and `finalize`
   refuses the untouched placeholder.

Read [references/report.md](references/report.md) before authoring the report and
[references/evidence.md](references/evidence.md) before capturing artifacts.

## Execute the selected surface

### macOS Electron desktop

1. Pass the desktop pre-launch boundary above, then build and launch from the adapter. Run every
   state-mutating case in a fresh launch with `--report-dir <round> --case-id <stable-id>`. Only a
   declared restart case may use `--case-mode restart --reuse-user-data`; its final launch must
   pass `--cleanup-reused-user-data`. A case whose plan declares `agentFixture` must also pass the
   same id through `--agent-fixture`; include the generated Agent fixture receipt in that case's
   evidence. Every launch uses isolated HOME, XDG directories, provider homes, and shell PATH with
   blocked Agent shims; the declared fixture replaces only those blocked Agent targets. Confirm the
   CDP target is the Caxri renderer, not DevTools or a stale resident build.
2. Drive the smallest real user path that proves each plan item. Follow
   [surfaces/electron.md](surfaces/electron.md). Stop before a native sheet or app-modal window and
   hand that step to the user unless the current request explicitly authorizes agent verification;
   deterministic fixtures prove the product behavior on either side of that manual boundary.
3. Capture evidence while testing:
   - settled UI state: screenshot plus DOM snapshot when useful;
   - behavior over time: GIF or video following
     [references/recording-cdp.md](references/recording-cdp.md), with every video chaptered by
     its steps, frame-level checks, and disclosed anomalies
     ([references/video-chapters.md](references/video-chapters.md));
   - non-visual behavior: separate reasoning and execution text artifacts.
     A Terminal fixture plan must declare `fixturePreflight: terminal`. Before any screenshot or
     recording of that fixture, run
     `fixture-preflight.ts --input <captured-fixture.json> --case-id <stable-id> --output <round>/assets/<case-id>-fixture-preflight.json`
     against its observed generation, first grid marker, DOM row count, borders, and rendered
     lines, then include the receipt in `cases[].evidence`. Finalization rejects a missing or
     blocked receipt, so direct screenshot capture cannot bypass preflight. `fixture_blocked` is
     infrastructure evidence and can never be converted to a product pass or fail.
4. Replace each generated `cases[]` placeholder as observations are made. Every planned check
   remains visible; never delete one to make coverage look complete.
5. Report failures honestly. Once round execution starts, a product failure, blocked environment,
   invalid screenshot, or missing evidence is part of that round's observed result.

### Caxri CLI

1. Follow [surfaces/cli.md](surfaces/cli.md). Build with `bun run build:cli` and point
   `--profile` at the isolated launch's `userDataDir`; Agent and CI invocations never start a
   Server implicitly, so an isolated Server must already exist. Never target the developer's
   resident profile.
2. Run the smallest command sequence that reaches the planned outcome, preferring `--json` so the
   proof is assertable. For a mutation, also capture the read-back that shows the new state.
3. Redirect stdout into the round's `assets/` and read it before citing it. A `cli` case keeps the
   same `stateIsolation` receipt as a desktop case, and strips pairing links, credentials, Agent
   transcripts, Session names, and Project paths from every artifact.

### Android

1. Use a disposable emulator for the automated encrypted pairing and short-reply path. Follow
   [surfaces/android.md](surfaces/android.md) and the exact command in
   `.agents/acceptance/PROJECT.md`. Pass the round directory and stable case id so the guarded
   runner records build identity, isolation, cleanup, and its sanitized result receipt.
2. Use a physical Android device only for explicitly planned visual, camera, radio, accessibility,
   or release-performance checks. Keep it unlocked and authorized through user action; never reset
   its app data as a fallback for an emulator-only case.
3. Capture device pixels with ADB and inspect them. Use sanitized `testID` semantics to choose a
   control and prove the postcondition; never upload the raw UIAutomator XML.

### iOS Simulator

1. Follow [surfaces/ios-simulator.md](surfaces/ios-simulator.md). Select one UDID, build the current
   native binary, and preserve Xcode/runtime/build identity before citing device evidence.
2. Use `simctl` for lifecycle and framebuffer capture. Use AXe or another already-installed native
   Simulator Accessibility/HID command-line driver for taps and gestures. Do not install a driver
   without authorization and do not treat macOS host-window clicks as native touch proof.
3. If no installed driver can express or observe the planned interaction, mark that case `blocked`.
   A clean launch screenshot may still support a narrower static-layout check, but cannot replace
   the blocked gesture or cross-device workflow.

## Keep checklist explanations brief

Write each check's `observation` and inline explanation in Simplified Chinese,
usually 1–3 short sentences: what was done, what happened, and any limitation
needed to judge that outcome. Do not paste the execution report into the check.
Omit repeated titles, verdict labels, SHA/port/ID headers, environment boilerplate,
and round-history explanations. Put shared setup and revision details once in
`report.md`; keep commands, traces, raw output, and detailed reasoning in
separate evidence attachments. Briefly disclose a limitation in the check when
it changes the verdict; concision must not hide missing verification.

Example: “切换 Session 后终端视口铺满工作区，边缘没有露出应用背景色条。”
For a failure, name the unmet outcome directly, without recounting the debugging
process. Keep required evidence complete; shorten its presentation, not the work.

**Every cited artifact MUST carry a non-empty, reviewer-facing `description`.**
Identify what the file contains and what it demonstrates for this check. A
filename, path, artifact id, or generic label such as “证据” is not a sufficient
description; `finalize` rejects a bare path and an English-only description.

## Publish immutable rounds

Follow [references/report.md](references/report.md) for the authoritative ingest commands and
result schema. Preserve the returned Acceptance id, URL, and round index. Never overwrite a
published round. If the post-publication readback does not contain every declared evidence item,
preserve that history and publish a corrected round. Run the report scaffold's `finalize` command
before every ingest. It computes the summary and fails locally on plan/case drift, missing
evidence, required-medium gaps, or English-only human-facing content. It does not check the
account's enforced language, so also run `lh acceptance run ingest "$ROUND_DIR" --dry-run` once
before the first real ingest; never publish only to test a payload.

If publication reports `storage_quota` (in `recovery.reason` or `failedEvidence[].reason`) or a
`storage_block:` error, follow [references/publication-recovery.md](references/publication-recovery.md):
keep the local evidence, report the coverage that actually uploaded, and give the user both
recovery options. Never delete user data automatically or re-ingest the whole round.

In `local` mode, or when the user asks to keep the report local, `finalize` the round as usual,
then validate and render it instead of ingesting, following
[references/report.md](references/report.md#render-locally-when-not-signed-in). Publishing to
LobeHub is required only when others must comment, review, or open a link; the user signs in with
`lh login`, and the existing rounds are published together.

## Repair loop

Before every follow-up, read current state and actionable feedback using the commands in
[references/report.md](references/report.md). A local acceptance reads the same feedback from its
acceptance root after the reviewer saves their reviews.

- Omit user-accepted checks unless the repair can regress them.
- Address non-stale rejects and reuse their stable check ids.
- Declare `supersedes` when a check's meaning is replaced, and retain the full lineage in later
  rounds.
- Route product failures back to implementation, focused validation, review, commit, and push
  before starting the next round.
- Repair adapter, fixture, capture, or report defects as verification infrastructure; do not
  mislabel them as Caxri product bugs.
- Never turn a native-dialog manual handoff into an adapter-repair loop. Without an explicit
  current user request for agent-driven native verification, stop at the deterministic Main
  boundary.
- After one honest blocked round caused by an infeasible evidence method, publish that
  observation, repair the plan or adapter at the owning boundary, and retry once. Do not keep
  improvising progressively finer timing probes for the same unobservable claim.

## Finish

Copy any cited Main or Runtime log excerpts into the round assets before stopping because the
isolated user-data directory is temporary. Stop only the Electron process started for this round,
and close the round's `agent-browser` session.
Clear only the Android package data owned by a disposable acceptance emulator. Terminate or
uninstall only the app instance owned by a disposable iOS acceptance Simulator; leave user-owned
emulators, Simulators, and physical devices running.

After owned product processes have stopped, record only verified, reusable project learnings using the
routing rules in `.agents/acceptance/PROJECT.md`: a mistake that cost a run belongs in
`common-mistakes.md`, a reusable probe or mock belongs in `probe-mock-patterns.md`, and an
environment or fixture fact belongs in the matching project reference. Do not turn a one-off
failure or an unverified hypothesis into guidance, and do not keep the desktop session open while
editing the learning log.

## Final handoff (mandatory)

Before declaring the task done, prove coverage: for each check with
`requiredEvidence`, every declared `type` is present at least once. Report it
explicitly; a missing type holds the delivery at `uncertain` no matter how good
the work is.

The final response MUST include the published acceptance URL (or, for a local round, the report
link) together with the coverage result: never only a check-result id or a prose claim. Keep local
reports under `.records/` and expose only the **acceptance** (`/acceptance/<acceptanceId>`), the
stable cross-round decision surface. Do not append `?r=<roundIndex>`: the page opens on its latest
round, so a per-round link adds nothing for the reader. Display LobeHub Cloud links on
`https://lobehub.com`: rewrite a returned `lobehub.com` subdomain origin such as
`app.lobehub.com` to it, preserving the path; keep self-hosted origins unchanged. For a local round,
copy the `reportUrl` (`file://` link to `report.html`) that `render --json` returned, and tell the
reader that **Save reviews** in the page is how their decisions reach you; it is the one local path
the reply carries. Put no images, other local paths or file links, or internal run-page paths in
the chat reply.

Write the link as a plain-text line, never inside a fenced or inline code block: the
chat client only linkifies plain text, and a code block makes it unclickable:

Acceptance: <https://lobehub.com/acceptance/ACCEPTANCE_ID> (the placeholder is the id ingest printed; it stays inside the URL)
Coverage: 2/2 criteria, all required evidence uploaded

For a local round, the first line is `Report: <reportUrl, verbatim>` and coverage says "rendered"
instead of "uploaded".

## Reference map

- Electron workflow: [surfaces/electron.md](surfaces/electron.md)
- Caxri CLI workflow: [surfaces/cli.md](surfaces/cli.md)
- Android workflow: [surfaces/android.md](surfaces/android.md)
- iOS Simulator workflow: [surfaces/ios-simulator.md](surfaces/ios-simulator.md)
- Independent plan/evidence review: [references/acceptance-checker.md](references/acceptance-checker.md)
- User-journey flows and checklist grouping: [references/flow.md](references/flow.md)
- CDP commands: [references/agent-browser.md](references/agent-browser.md)
- Evidence rules: [references/evidence.md](references/evidence.md)
- Native dialogs: [references/native-dialogs.md](references/native-dialogs.md)
- Report schema: [references/report.md](references/report.md)
- Storage-limit recovery: [references/publication-recovery.md](references/publication-recovery.md)
- Temporal capture: [references/recording-cdp.md](references/recording-cdp.md)
- Video chapters: [references/video-chapters.md](references/video-chapters.md)
- Android temporal capture: [references/recording-android.md](references/recording-android.md)
- iOS Simulator temporal capture:
  [references/recording-ios-simulator.md](references/recording-ios-simulator.md)
- Project mistakes: [../../acceptance/common-mistakes.md](../../acceptance/common-mistakes.md)
- Project probe/mock patterns:
  [../../acceptance/probe-mock-patterns.md](../../acceptance/probe-mock-patterns.md)
- Project field notes: [../../acceptance/references/](../../acceptance/references/)
