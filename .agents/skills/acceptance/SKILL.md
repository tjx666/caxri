---
name: acceptance
description: >
  Verify Caxri deliveries on the real macOS Electron desktop surface, capture
  visually inspected evidence through CDP, and publish immutable review rounds
  with the LobeHub CLI. Use when Caxri work must prove user-visible behavior,
  generate an acceptance report, respond to acceptance feedback, or re-verify a
  repair. This project-local skill is strictly limited to Caxri's macOS Electron
  desktop product surface.
---

# Caxri Acceptance

Builders may produce delivery evidence, but only a separate human review may accept or reject it.
Treat macOS Electron desktop as the only product surface. Use focused tests, build output, logs, or
probes as supporting evidence, never as substitutes for the real desktop path when the claim is
user-visible.

## Boundaries

- Exercise Caxri in an isolated Electron instance. Never drive the developer's resident app or real
  user-data directory.
- Acceptance forces Agent discovery to `blocked` unless the frozen case plan declares a
  repository-owned fake Agent fixture. Pass that exact fixture id to the launcher; arbitrary
  executables, environment authority, and host Agent providers remain forbidden. Never capture real
  Agent Terminal output or transcripts. The manual real-Agent smoke and the `debug` skill's
  controlled probe are supporting workflows, not Acceptance evidence.
- A resident Caxri dev app is normal and must remain usable. `start-electron.ts` gives each
  Acceptance launch its own temporary macOS app bundle identity; never ask the developer to stop
  their app or fall back to global app-name, frontmost-window, or coordinate targeting.
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
  [references/native-dialogs.md](references/native-dialogs.md); general Acceptance, `$go`, or
  complete-real-path wording does not.
- Read every screenshot or recording before citing it. A file existing is not evidence that the
  expected UI rendered.
- Keep focused regression tests separate from acceptance evidence. Tests prove a contract; the
  desktop round proves the delivered user experience.
- Keep desktop evidence at the user-observable boundary. Do not use repeated injections,
  screenshots, or timing guesses to claim an internal callback order that the UI cannot expose;
  prove the visible before/after outcome on the desktop and use the smallest focused test or log
  receipt for the internal ordering contract.
- Do not call `accept` or `reject` as the builder.

## Prepare

1. Read `.agents/acceptance/PROJECT.md` for the exact build, isolated launch, stop, CDP, and
   logging commands. Then read
   [`.agents/acceptance/common-mistakes.md`](../../acceptance/common-mistakes.md) before planning
   the round, load the matching project field notes indexed by `PROJECT.md`, and search
   [`.agents/acceptance/probe-mock-patterns.md`](../../acceptance/probe-mock-patterns.md) before
   authoring a new probe or mock. Fix adapter drift when observed.
2. Confirm production LobeHub authentication with `lobehub whoami --json`. Do not guess an
   `auth status` subcommand; the Go intake snapshot runs this same fail-closed probe automatically.
3. Resolve the immutable one-sentence business requirement for the whole acceptance. Write it in
   Simplified Chinese. The scaffold freezes it in the acceptance root so every later round must
   reuse the exact same requirement.
4. Author `plan[]` before testing. Give each check a stable id tied to the owning GitHub issue and
   declare its expected behavior, required evidence, and `stateIsolation`. The scaffold defaults
   every case to `isolated`; use `readonly_checkpoint` only for an explicitly immutable checkpoint,
   and use `restart` only with one named profile whose final launch owns cleanup. Write all
   human-facing report prose in Simplified Chinese; keep machine ids, code identifiers, branches,
   commits, commands, and artifact paths in English. For every temporal check, name the observable
   start marker, end marker, and stop condition before launching. If the claimed ordering has no
   observable desktop marker, split the evidence into a desktop outcome and a focused supporting
   contract instead of starting an open-ended experiment.
5. Run the report scaffold's `init` command with the frozen plan. It creates a fresh round
   directory containing case placeholders, `report.md`, and `assets/`. Inside Go use
   `.records/go/<run-id>/acceptance/round-<n>/`; for standalone verification use
   `.records/acceptance/<timestamp>/round-<n>/`.

Read [references/report.md](references/report.md) before authoring the report and
[references/evidence.md](references/evidence.md) before capturing artifacts.

## Execute the desktop round

1. Pass the pre-launch boundary above, then build and launch from the adapter. Run every
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
     [references/recording-cdp.md](references/recording-cdp.md);
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

## Publish immutable rounds

Follow [references/report.md](references/report.md) for the authoritative ingest commands and
result schema. Preserve the returned Acceptance id, URL, and round index. Never overwrite a
published round. If ingest partially succeeds but warns that evidence was dropped, preserve that
history and publish a corrected round. Run the report scaffold's `finalize` command before every
ingest. It computes the summary and fails locally on plan/case drift, missing evidence,
required-medium gaps, or English-only human-facing content.

Inside Go, never call raw `lobehub acceptance run ingest`. Use the Go `acceptance-publish` command
so later rounds are forced onto the frozen Acceptance id and publication is recorded only after
the server readback matches the exact head, round index, stable check ids, and verdict. Record an
accidental standalone with `acceptance-orphan`; immutable remote history is never deleted.

## Repair loop

Before every follow-up, read current server state and actionable feedback using the commands in
[references/report.md](references/report.md).

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
isolated user-data directory is temporary. Stop only the Electron process started for this round.
Keep local reports under `.records/` and expose only the stable production acceptance URL in the
user handoff. The latest round must show complete required-evidence coverage before the delivery
can wait for human acceptance. When Go owns the delivery, return the published round to Go; the Go
ledger, not the Acceptance report, owns the compact workflow-observation summary shown beside that
URL.

After the owned desktop has stopped, record only verified, reusable project learnings using the
routing rules in `.agents/acceptance/PROJECT.md`: a mistake that cost a run belongs in
`common-mistakes.md`, a reusable probe or mock belongs in `probe-mock-patterns.md`, and an
environment or fixture fact belongs in the matching project reference. Do not turn a one-off
failure or an unverified hypothesis into guidance, and do not keep the desktop session open while
editing the learning log.

## Reference map

- Electron workflow: [surfaces/electron.md](surfaces/electron.md)
- CDP commands: [references/agent-browser.md](references/agent-browser.md)
- Evidence rules: [references/evidence.md](references/evidence.md)
- Native dialogs: [references/native-dialogs.md](references/native-dialogs.md)
- Report schema: [references/report.md](references/report.md)
- Temporal capture: [references/recording-cdp.md](references/recording-cdp.md)
- Project mistakes: [../../acceptance/common-mistakes.md](../../acceptance/common-mistakes.md)
- Project probe/mock patterns:
  [../../acceptance/probe-mock-patterns.md](../../acceptance/probe-mock-patterns.md)
- Project field notes: [../../acceptance/references/](../../acceptance/references/)
