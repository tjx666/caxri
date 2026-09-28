---
kind: historical
status: historical
---

# Architecture refactor behavior parity

[Server architecture refactor plan](./server-refactor-plan.md) cites this contract as the Acceptance
method its now-implemented batches used; it stays as the historical record of that methodology.

- Date: 2026-08-25

## Contract

An architecture refactor must not change Caxri's user-observable behavior. Passing new-unit tests proves
the replacement implementation works; it does not prove that the product still behaves like the exact
pre-refactor build. Every refactor batch therefore runs the same frozen behavior scenarios against a
before artifact and the candidate exact head and compares normalized product-boundary evidence.

Future capabilities such as concurrent Clients, durable shared Drafts, remote pairing, Relay access, or
Terminal survival across a Server Core restart are not parity exceptions. They land later as explicit
product changes with their own requirements and Acceptance.

## Evidence hierarchy

Evidence is collected at the closest stable product boundary:

1. behavior-level tests define commands, outcomes, state transitions, and failure semantics;
2. normalized command, reply, event, persistence, and process-lifecycle receipts prove non-visual paths;
3. focused real-Electron E2E proves cross-process wiring, PTY behavior, recovery, and native lifecycle;
4. real Desktop Acceptance proves visible behavior with inspected screenshots or recordings;
5. structured logs support causal diagnosis but are never the sole parity oracle.

Raw log-text equality is intentionally rejected. Process names, transport details, timing, ports, IDs,
and internal event decomposition must change during the refactor and are not product behavior.

## Frozen baseline

Before the first source movement, create one immutable baseline manifest containing:

- repository commit, tree, build ID, app version, protocol version, and artifact hashes;
- operating system, architecture, locale, time zone, shell, viewport, theme, font, and fixture versions;
- isolated profile and Project fixture recipes, never a developer profile or real Project;
- scenario IDs, setup state, action sequence, expected semantic result, and evidence schema;
- normalization rules and the initial intentional-difference allowlist;
- focused test, production build, packaging, startup, and benchmark command receipts.

The baseline runs from a clean isolated worktree. State-mutating scenarios use fresh profiles. Declared
restart scenarios may clone one frozen seed profile and run sequentially; before and after artifacts never
share a live profile. Electron desktop runs are serialized through the repository lease.

Baseline artifacts live under `.records/refactor-parity/<baseline-id>/` and are immutable after capture.
The record archives the already built before artifact itself, not only its build recipe, and hashes every
file needed to run it months later. The durable document records the evidence schema and reproduction
commands; large evidence, artifacts, and local profiles remain gitignored.

Later comparisons run that archived artifact in the same valid environment as the candidate. A rebuild is
an integrity experiment, not a substitute: a hash mismatch or a before artifact that no longer starts is
`blocked`, never silently replaced by stored output. The baseline manifest names a fixed fallback machine
or virtual environment; if neither can run the artifact, affected scenarios require explicit human
adjudication and cannot appear green.

## Strengthen tests before refactoring

The baseline is not allowed to merely memorialize today's incomplete coverage. Before implementation:

- inventory every public protocol method from the registry and classify principal, capability, effect,
  idempotency, success result, and stable error families;
- add missing regression tests against the old implementation at the narrowest owning boundary;
- add focused E2E only where failure can exist exclusively across Electron, PTY, process, persistence,
  or packaging boundaries;
- freeze current recovery and security rejection sequences with deterministic fault injection;
- prove the comparator catches seeded differences in an error code, event order, CLI exit code, Terminal
  status, persistence projection, and visible UI state.

Tests must assert product behavior rather than implementation vocabulary. A parity test cannot require a
generic Host, Runtime, control endpoint, process count, source path, or internal message name unless that value is
itself a documented public contract.

## Scenario catalog

The initial catalog covers at least:

| Surface           | Frozen behavior                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Startup           | first launch, existing profile attach, background process reuse, packaged launch, clean shutdown               |
| Project           | authorize, select, linked root, containment rejection, metadata-only removal, watcher-driven Files/Git refresh |
| Session           | create, select, rename, archive, restore, delete, root switching, state restore                                |
| Workbench         | pane layout, Terminal/document placement, active selection, reload, current dirty-buffer semantics             |
| Terminal          | create, input, output, resize, attach, detach, restart, exit, snapshot restore, stale attachment reject        |
| Agent             | launch, metadata binding, activity, Attention, Endpoint auth, generation fencing, provider failure             |
| Extension         | activation, contributed views, API generation fencing, failure isolation, stable rejection                     |
| CLI               | stdout, stderr, JSON output, exit code, Desktop wait, unavailable Server, invalid arguments                    |
| Protocol          | principals, denial, invalid input, timeout, disconnect, duplicate request, event resume, lease replacement     |
| Desktop ownership | current Desktop replacement, revocation, stale generation rejection, `waitForDesktopLease`                     |
| Persistence       | logical Project, Session, Terminal, Workbench, settings, and recovery projections                              |
| Security          | wrong credential, wrong profile, stale generation, path escape, symlink swap, oversized payload                |
| Recovery          | Client reconnect, Renderer reload, stale build replacement, user-visible crash recovery outcome                |
| Visual            | critical Desktop navigation, restored Session, pane layout, Terminal, Editor, Attention, Process Explorer      |

Native folder dialogs remain a manual boundary. Automated parity stubs their result and compares the
product state before and after the dialog; the refactor does not authorize driving native system UI.

## Semantic evidence

Each scenario may emit a bounded JSON receipt with:

- scenario and step IDs;
- normalized command and result kinds;
- stable error code, reason, retryability, and remediation category;
- ordered public event kinds, content-safe normalized payload digests over allowed fields, and resource
  revisions;
- logical persistence projection before and after the action;
- Terminal generation, dimensions, exit status, and a content-free screen fingerprint when needed;
- CLI exit code and redacted structured output;
- process lifecycle states and build identity;
- duration and resource measurements kept outside semantic equality.

Receipts never contain source text, Draft bodies, Terminal output, prompts, transcripts, credentials,
environment values, or secret-like settings. When Terminal text itself is the expected product result,
the deterministic fixture asserts it in memory and records only the declared marker or fingerprint.

Database schemas are not compared. A stable exporter produces the logical domain projection so a table
split or migration can pass when the observable state remains equivalent.

## Normalization and comparison

The comparator is schema-aware, not a regular-expression scrubber. It normalizes only fields declared by
the evidence schema, including:

- timestamps and durations;
- process IDs, ports, temporary paths, random IDs, and connection IDs;
- build identity when comparing different exact heads;
- ordering explicitly documented as concurrent and semantically irrelevant;
- internal process names and transport-specific receipts.

Everything else is compared strictly. Missing fields, unknown event kinds, an unclassified error, extra
public events, changed CLI output, a persistence mismatch, and a new visible state fail closed.

An intentional difference requires a reviewed entry containing the scenario, exact field, before value,
after value, product rationale, owning issue, and expiration batch. Architecture-only batches may allow
internal endpoint, process, or build evidence differences; they may not allow user-visible behavior.

Each scenario declares why it is deterministic, which environment checks make the sample valid, and
which bounded repetitions detect known variance. A flaky scenario is `invalid` and quarantined from the
green summary only while an owning verification issue remains open; it cannot gain a wider threshold or
intentional-difference entry merely to stop failing.

## Visual parity

Critical user-visible scenarios run sequentially against both production artifacts with the same fixture,
profile seed, theme, viewport, and window size. Acceptance captures and inspects the real Electron
surface through CDP. The comparison combines:

- DOM or accessibility semantics for labels, selected state, focus, and available actions;
- screenshots for layout, Terminal, Editor, and Attention surfaces;
- recordings only when the behavior is temporal and a settled screenshot cannot prove it.

Pixel differences caused solely by rendering nondeterminism require semantic evidence and a reviewed
mask or threshold. A changed layout, copy, command availability, focus path, or interaction result is a
product regression, not a normalization candidate.

Process Explorer has a data-dependent parity contract: it must accurately list the processes that exist
in each architecture and preserve its current actions, labels, loading, failure, and refresh behavior.
The actual process rows and resource measurements are environment data, like CPU usage, rather than a
frozen list of old process names.

## Performance parity

Performance is compared as a budget, not exact equality. The baseline records repeated samples for:

- packaged startup and attach;
- command queue wait and execution;
- interactive Terminal echo and resize;
- reconnect and state recovery;
- memory, file descriptors, watcher count, database latency, and buffered connection bytes.

Each metric has a frozen sample count, percentile or maximum statistic, regression threshold, and
environment validity check. Millisecond metrics require both the frozen relative regression and a 5ms
absolute delta so single-digit-millisecond operations are not failed by scheduler or filesystem jitter; their
absolute ceiling remains unconditional. A faster result does not excuse a semantic failure; a semantic
pass does not excuse a budget regression.

Process resource metrics compare the complete set of general Server owners rather than one historical
PID. The immutable A0 receipt sampled only Runtime, so A3a adds a source-bound topology baseline from
the same archived artifact and fixture: Host plus Runtime used 241.69–242.58 MiB and 78 open file
descriptors across three repetitions. From A3a onward the candidate sums Server Core plus any later
split Terminal Host, while Extension Host remains excluded on both sides. The original ratio and
absolute ceilings still apply; this additive baseline cannot normalize or allowlist a regression.

## Per-batch gate

Every architecture batch follows the same order:

1. build the exact candidate head;
2. run focused unit and integration coverage;
3. replay the frozen non-visual scenario set in isolated profiles;
4. compare semantic receipts and performance budgets;
5. run the smallest owning Electron E2E cases;
6. run the frozen visible Acceptance set when the batch touches packaging, Desktop wiring, persistence,
   Terminal, recovery, or Renderer-facing protocol;
7. inspect every difference and reject unknown or product-visible changes;
8. store the exact-head comparison receipt before starting the next batch.

A later green batch cannot erase an earlier unexplained red result. Baseline or comparator changes are
reviewed as verification-infrastructure changes and must be proven against the original before artifact.

Crash parity is defined at the product boundary: the same user-visible recovery-state sequence, data
preservation, Terminal death reporting, available actions, and recovery-time budget. Internal process
lifecycle receipts may differ and are normalized, but the resulting UI, CLI, persistence, and stable
failure semantics may not.

## Known proof limits

The frozen catalog cannot prove behavior it does not enumerate, every possible scheduler interleaving,
cross-version operating-system behavior, indefinite resource evolution, or arbitrary third-party Agent
CLI behavior outside deterministic fixtures. A7 reports these limits explicitly rather than implying
complete behavioral equivalence beyond the catalog and environments actually exercised.

## Reusable harness

The implementation phase should add one repository-owned runner, conceptually
`scripts/refactor-parity.ts`, with `record`, `compare`, and `verify-baseline` commands. It owns scenario
selection, isolated profile creation, normalized receipts, manifest hashes, and comparison summaries.
Product-specific actions remain in existing unit, Playwright, and Acceptance fixtures rather than being
reimplemented in the runner.

The runner exits nonzero on missing scenarios, invalid evidence, unknown differences, stale artifacts,
privacy violations, or budget regressions. Its summary lists every planned scenario as pass, fail,
blocked, or invalid; omitted coverage can never appear green. Baseline JSON inputs use strict schemas and
the archive writes only their parsed canonical values, so an undeclared field cannot bypass privacy checks.
Normalization and intentional differences are restricted to declared internal or artifact evidence;
performance samples and product-visible semantics can never be exempted.

The canonical catalog, typed normalization rules, and reviewed intentional-difference allowlist live in
`scripts/refactor-parity/`. The initial local baseline is `before-d370c789-macos-arm64-v5`, built from
commit `d370c789eb24185ee6d6d256f540a6aceedae97c` and tree
`f0e0725dc550c4fba1964216db471182dc684be6`. Its source build ID is `e6b6b5de0c018db6`, application
version is `0.0.18`, and protocol version is `2`.

Reproduce the runner gate from the architecture Goal worktree:

```bash
bun run refactor:parity verify-baseline \
  --baseline .records/refactor-parity/before-d370c789-macos-arm64-v5

bun run refactor:parity compare \
  --baseline .records/refactor-parity/before-d370c789-macos-arm64-v5 \
  --candidate-artifact release.noindex/mac-arm64/Caxri.app \
  --candidate-receipt <exact-head-receipt.json> \
  --batch <A0|A1|A2a|A2b|A2c|A2d|A2e|A2f|A3a|A3b|A4|A5|A6|A7> \
  --output <exact-head-summary.json>
```

The candidate receipt carries the aggregate hash of the supplied candidate artifact and must match the
clean worktree's exact Git commit and tree. The runner requires the fixed packaged source marker in
`Contents/Resources/app.asar` to resolve uniquely to that full commit.
The baseline archived the complete arm64 `Caxri.app`, including Framework symlinks. The manifest hashes
regular files, modes, symlink targets, catalog, receipt, normalization rules, and allowlist, then runs a
mandatory bounded startup probe against an executable inside the archived artifact. Re-recording the same
baseline ID is rejected.
The exact artifact is local and gitignored; losing it is a blocked parity gate, not permission to rebuild
or silently select another artifact.
