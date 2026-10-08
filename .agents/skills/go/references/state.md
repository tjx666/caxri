# Durable Run State

The [Go skill](../SKILL.md) owns the ledger trust model. The commands below validate cooperative
state and lineage; a failed transition is an internal consistency result, not independent
attestation that a recorded command or review claim is true.

New runs start through the isolated-worktree entry point:

```bash
bun run .agents/skills/go/scripts/start.ts \
  --objective "<business goal>" --branch "chore/<goal-slug>"
```

Keep the returned worktree and `.records/go/<run-id>/state.json` paths. Resume only in that
worktree. The ledger accepts schema v1 only. If an older ledger is encountered, start a new Go run
instead of translating or mutating it.

## Core commands

```bash
bun run .agents/skills/go/scripts/state.ts phase \
  --state "$STATE" --phase issue_execution --reason "Goal created"

bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --title "修复 Terminal 内边距" \
  --status progressing --priority P0 --check issue-42-terminal-inset

# Record a non-material assessment without creating a GitHub comment.
bun run .agents/skills/go/scripts/state.ts drift-assess \
  --state "$STATE" --number 42 --head-sha abc1234 \
  --kind internal_detail --drift-key final-assessment

# Material drift requires the complete four-part Chinese decision record.
bun run .agents/skills/go/scripts/state.ts drift-assess \
  --state "$STATE" --number 42 --head-sha abc1234 \
  --kind acceptance_change --drift-key terminal-evidence \
  --expectation "原计划使用截图证明 Terminal 恢复。" \
  --evidence "真实运行表明该行为只能由时序视频证明。" \
  --decision "保持产品范围，改用视频证据。" \
  --acceptance-impact "稳定检查 issue-42-terminal-inset 改用视频。"

bun run .agents/skills/go/scripts/state.ts drift-comment \
  --state "$STATE" --number 42 --record-id terminal-evidence-r1

bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --status complete \
  --commit abc1234 --validation "focused test passed"

bun run .agents/skills/go/scripts/state.ts pr \
  --state "$STATE" --number 123 --url "https://github.com/..." \
  --status open --head-sha abc1234
```

Freeze the review policy before the aggregate baseline. The default is
`full-once`; use an override only for an explicit pre-review decision.

```bash
BASELINE_HEAD="$(git rev-parse --verify 'HEAD^{commit}')"

bun run .agents/skills/go/scripts/state.ts review-policy \
  --state "$STATE" --mode full-once --source "Go default"

bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha "$BASELINE_HEAD" --mode full --p0 0 --p1 0 \
  --scope "Goal-range product review" \
  --reviewed-range "origin/main...${BASELINE_HEAD}" --freeze

# After committing the reviewed repair:
CURRENT_HEAD="$(git rev-parse --verify 'HEAD^{commit}')"

bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha "$CURRENT_HEAD" --mode light --p0 0 --p1 0 \
  --scope "P1 repair delta" --baseline-review-id review-001 \
  --baseline-head-sha "$BASELINE_HEAD" --parent-review-id review-001 \
  --reviewed-range "${BASELINE_HEAD}..${CURRENT_HEAD}" --freeze
```

Ordinary review recording resolves the ledger worktree's canonical `HEAD`, requires no active mutation lease and a
clean Git-visible source state, and rejects a declared SHA that does not exactly match it. A second integrity read at
the persistence boundary rejects a concurrent HEAD or source-status change. If the latest frozen nonbaseline review
instead contains a transcription-only SHA that does not resolve as a Git commit, reconcile that one unconsumed
record with:

```bash
bun run .agents/skills/go/scripts/state.ts review-reconcile-head \
  --state "$STATE" --review-id review-017 \
  --reason "The recorded full SHA was transcribed incorrectly before any downstream evidence ran."
```

The reconciliation resolves `HEAD` and its parent from the recorded worktree, rejects a valid old SHA or any
downstream validation, fallback, publication, handoff, finalization, or cleanup, and writes the complete original
review into the append-only event audit before correcting only its head, range, and freeze. It deliberately permits
uncommitted tooling edits because those files remain outside the already reviewed commit; two Git-visible worktree
identity reads must still match across the operation. The command never accepts a replacement SHA or range.

Record validation independently from review through the runner. Tokens after `--` are passed as one executable and
its argument vector; they are never interpreted as a shell command.

```bash
bun run .agents/skills/go/scripts/state.ts validation-run \
  --state "$STATE" --kind gates --lineage-id typecheck-repair \
  --head-sha def5678 --session-id codex-typecheck -- \
  bun run typecheck
```

`validation-run` resolves `HEAD` and a clean source fingerprint from the ledger's recorded worktree.
`--head-sha` is an optional expected-head assertion, never the source of truth. The runner records pending under a
short state lock, releases the lock while the process runs, mirrors stdout/stderr to the terminal, and writes a private
`validation/validation-NNN.log`. Completion rechecks HEAD and the fingerprint, then records duration, exit code or
signal, log byte length, immutable file metadata, and SHA-256. The command receives only an explicit allowlist of
toolchain and locale environment variables; GitHub tokens and other ambient credentials are excluded before launch.
Raw arguments stay in process memory only; persisted state and log headers retain a SHA-256 command identity,
argument count, and either the canonical public gate command or a bounded secret-free display label. Child output is
limited to 64 MiB with stream backpressure, and a validation that exceeds that limit or the 30-minute wall-clock
deadline is terminated with a complete failed receipt.
Ignored artifacts do not invalidate the receipt, but commits, tracked edits, and
non-ignored untracked files produce a failed receipt. The wrapper exits with the child exit code when one exists.

SIGINT and SIGTERM are forwarded to the complete child process group before the failed receipt is finalized. If the
runner is killed without a catchable signal, the next `validation-run` revalidates the recorded runner and process-group
identities, terminates only a group whose ownership is still provable, marks the old receipt `runner_lost`, and only
then starts a new attempt. A recycled PID is never treated as authority to signal an unrelated process.
The supervisor remains inert until its process-group ID is durably recorded, so even SIGKILL cannot strand a command
in the launch window. Ordinary ledger reads check only the newest completed validation log's direct-file identity,
timestamps, and size, keeping lock-held file work bounded as history grows. Evidence-consuming transitions and
`state.ts validate` audit every version-1 managed log and recompute every SHA-256. A damaged receipt is durably
invalidated before the transition can continue; evidence for that head requires a later passing replacement of the
same command. Explicit `state.ts validate` continues to report the damaged historical artifact after replacement.

Wrap every repair mutation batch in the durable single-writer lease:

```bash
bun run .agents/skills/go/scripts/state.ts mutation-acquire \
  --state "$STATE" --kind repair --holder-id issue-42-repair

bun run .agents/skills/go/scripts/state.ts mutation-release \
  --state "$STATE" --kind repair --holder-id issue-42-repair
```

Formal validation owns the same lease automatically, so a repair writer and validation can never
overlap in one run worktree.

Record phase costs and route workflow-only work before absorbing it:

```bash
bun run .agents/skills/go/scripts/state.ts checkpoint \
  --state "$STATE" --boundary batch --tokens unavailable \
  --commit-count 4 --file-count 18 --revised-eta "One required gate remains"

bun run .agents/skills/go/scripts/state.ts scope-admit \
  --state "$STATE" --title "General CI cleanup"
```

Elapsed time is always derived from the ledger timestamps. Missing harness token usage is recorded
as degraded telemetry. Issue completion appends an issue checkpoint with the committed Git/file
delta; checkpoints never replace earlier records from the same phase. Once a hard threshold is
reached, optional proof, P2/P3 expansion, and discretionary probes are contained while the
authorized terminal outcome remains active.

## Handoff and finalization

Publish a finalized round through the exact-lineage wrapper:

```bash
bun run .agents/skills/go/scripts/state.ts acceptance-publish \
  --state "$STATE" --report-dir "$REPORT_DIR" --head-sha def5678
```

The command stores the stable Acceptance id/URL, immutable run id, round index,
head, check ids, and verdict only after an exact remote readback. For an earlier
accidental standalone, use `acceptance-orphan` to retain its id, run id, and
reason without replacing the frozen lineage. When ingest succeeds but readback
fails, `resume` points to the persisted pending attempt and the same command
retries only remote readback.

Do not pass `--round` to the ordinary `state.ts acceptance` status command.
`acceptance-publish` owns normal round advancement;
`acceptance-reconcile-round` is only for an explicit, reasoned repair of ledger
drift.

When the current authenticated principal can read the public frozen Acceptance
but cannot append to it, first verify the ownership mismatch and that no pending
publication exists. Restart the active lineage explicitly; the old publication
history remains immutable and the replacement report starts again at round one:

```bash
bun run .agents/skills/go/scripts/state.ts acceptance-restart-lineage \
  --state "$STATE" --acceptance-id "acc-old" \
  --reason "The authenticated principal cannot append the frozen Acceptance."
```

After a passing Acceptance round, move to `acceptance_handoff`, generate the
report, deliver the same summary with its stable Acceptance URL, and only then
record delivery and enter `waiting_acceptance`:

```bash
bun run .agents/skills/go/scripts/state.ts report-generate \
  --state "$STATE" --head-sha def5678

bun run .agents/skills/go/scripts/state.ts report-delivered \
  --state "$STATE" --head-sha def5678 --acceptance-url "https://app.lobehub.com/..."
```

If the user explicitly waives Acceptance for a non-product exact head,
record `status=waived`, `waived-head-sha`, and the reason. The report still must
be generated before merge and delivered before completion.

After merge and refreshed remote verification:

```bash
bun run .agents/skills/go/scripts/state.ts finalization-generate \
  --state "$STATE" --head-sha def5678 --merge-sha fed9876 \
  --issue 42:CLOSED:Done

bun run .agents/skills/go/scripts/state.ts finalization-delivered --state "$STATE"

bun run .agents/skills/go/scripts/state.ts resource-audit --state "$STATE"
```

Run `resource-audit` only after both delivery receipts exist. It fails closed on pending validation
or mutation ownership, a current-worktree dev process or desktop lease, Acceptance runtime state,
Go temporary files, or another live process tied to the recorded worktree. It persists no command
arguments. Reclaim each confirmed current-Go resource through its owning skill, rerun the command,
and pass one repeated `--recovered KIND` per category actually cleaned. A later mutating command
invalidates the receipt; read-only `resume`, `show`, `notes`, and `validate` do not.

The state transition to `waiting_acceptance` fails validation when the report is absent,
incomplete, stale, checksum-invalid, or undelivered. The transition to `complete` fails until the
same exact-head handoff and finalization receipts exist, their files match the ledger, the PR is
merged, every intended issue is `CLOSED` / `Done`, and the final resource audit belongs to the
current run and recorded worktree.

## Resume and rules

```bash
bun run .agents/skills/go/scripts/state.ts resume --state "$STATE" --json
bun run .agents/skills/go/scripts/state.ts validate --state "$STATE"
```

Use command-level help instead of guessing option order or enum values:

```bash
bun run .agents/skills/go/scripts/state.ts help validation-run
bun run .agents/skills/go/scripts/state.ts phase --help
```

- Update state only through the script. Every command acquires an atomic per-run lock owner receipt and
  fails closed when another live process owns it. If an owner is forcibly killed, the next command verifies
  that its PID is dead and safely reclaims the stale receipt; malformed or older-format locks still fail closed. State and
  history artifacts use exclusive unpredictable temporary files, ownership/no-follow checks, and
  atomic replacement.
- Do not call raw `lh acceptance run ingest` inside Go. A `pending`
  Acceptance without verified publication history, or with a stale exact head,
  cannot enter handoff or survive ledger validation.
- Treat GitHub and LobeHub as authoritative and refresh at delivery boundaries.
- Recording a changed PR head invalidates fallback evidence, report/finalization
  receipts, and any freeze that does not already bind the replacement head.
- Start formal validations only through `validation-run`. It automatically recovers a dead managed runner; an active
  runner remains blocked for explicit investigation.
- Do not rerun a passed exact-head validation without invalidation.
- Preserve original zero-step infrastructure evidence and keep Actions CI externally blocked when
  the guarded fallback passes.
- Store raw logs in the run directories, not in `state.json`; never copy the
  Codex transcript into the run record.
- Notes are typed, limited to 4,096 characters, and secret-shaped values are redacted before they
  enter the ledger. Long-lived collections are capped; overflow is stored in a content-addressed
  `artifacts/ledger-history-<sha256>.json` file whose count, per-collection summary, and digest stay
  in `state.json`. Archives fail closed at 8 MiB, and ordinary resume validates only their direct
  file metadata; inspect the artifact only for a targeted audit.
- Git, GitHub, and LobeHub child processes share a bounded runner: 60-second default timeout,
  combined stdout/stderr byte ceiling, TERM-to-KILL escalation, and byte-count-only failure
  evidence. `issue-drift` scans at most ten 100-comment pages and stops as soon as its marker is
  found.
- Explicitly assess expectation drift for each issue commit. `detected` blocks
  issue completion, PR readiness, and finalization until its comment URL is
  recorded. `decision_required` remains blocked after commenting until a new
  resolved decision revision is published. Identical resume attempts reuse the
  existing comment URL and never post duplicates.
- Acceptance requires every issue to be assessed at the exact delivered head, so
  a cross-issue repair that moves that head leaves each earlier assessment stale.
  `Issue #N expectation drift assessment does not match the required head` is what
  that looks like. Re-attest with the non-material form; it refreshes the
  assessment head and leaves a published decision intact:

  ```bash
  bun run .agents/skills/go/scripts/state.ts drift-assess \
    --state "$STATE" --number 42 --head-sha "$(git rev-parse HEAD)" \
    --kind internal_detail --drift-key final-assessment
  ```

  Do not re-assert an unchanged decision as material drift instead. The
  fingerprint is head-scoped, so the ledger reads that as a new revision and
  demands a duplicate of the comment already published.

- Re-attestation does not launder unfinished drift. A decision nobody published
  or one still owed to the user rejects the non-material form with
  `A non-material assessment cannot clear an unpublished material drift` or
  `... a material drift that is still waiting on the user`. Publish it with
  `drift-comment`, or publish the resolved revision, and then re-attest.
