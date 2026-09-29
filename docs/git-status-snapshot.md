---
kind: living
status: current
---

# Git status snapshot architecture

Durable record of the incremental Git topology/status pipeline shipped for
[issue #142](https://github.com/tjx666/caxri/issues/142): a single `RepoTopologyRegistry` and a
generation-keyed `RepoStatusStore` replace the previous per-`git.summary` discovery/status chain,
paired with a narrow-scope Git metadata watcher and a repository-identity invalidation event. All
source lives under `apps/server/src/domains/git/`.

## Goals

- One canonical repository topology and one canonical working-tree status snapshot per repository
  generation, shared by every consumer (`git.summary`, `git.overview`, Workbench Root candidate
  discovery) instead of each consumer re-running `worktree list` / `rev-parse` / `status`.
- Refresh only the repository whose Git metadata or working tree actually changed, attributed by
  repository identity rather than Session `staleTime`.
- Keep the existing correctness guarantees: Project authorization, Session isolation, the
  three-second large-Project gate, and a bounded working-tree `files[]` payload.

## Pull request commit availability

PR metadata comes from the shared GitHub projection, while file lists and editor diffs use local
Git objects. A remote base or head can be newer than an independently cloned submodule. Before
computing a PR range, `GitPullRequestService` checks both commit objects and fetches only missing
OIDs from the repository's `origin`. This does not update refs, tags, `FETCH_HEAD`, the index, or
working files, and does not recurse into submodules or run automatic maintenance. Repositories
that already contain the objects require no additional network access.

Fetch failures remain retryable and use a safe, actionable message in Source Control. The repository
header reports `Unavailable`; the resource count is not a successful PR file count while an error
is displayed. Use **Refresh Pull Request** after restoring remote access. Arbitrary Git stderr is
not displayed by the extension. Existing Git command timeouts and concurrency limits also govern
these bounded object fetches.

## Topology registry

`apps/server/src/domains/git/topology.ts` — `RepoTopologyRegistry` is the single owner of linked-worktree
discovery. `repositoryKey` is the realpath of the shared common Git directory (`--git-common-dir`),
so every linked worktree of one repository group resolves to the same key regardless of which root
started the lookup. A `rootIndex` (canonical worktree root → `repositoryKey`) lets a cached lookup
from any sibling worktree join the same topology entry without spawning Git.

- `topology(root, { force })` returns the cached topology when its `generation` matches the
  registry's current generation for that `repositoryKey`; otherwise it loads through a
  `SingleFlight` keyed by canonical root, so concurrent callers for the same repository join one
  `worktree list` + `rev-parse --git-common-dir` pair.
- `force: true` always reloads. Workbench Root flows use this because they must observe an Agent's
  `git worktree add` before any watcher signal can land; `GitService.worktreeTopology` in
  `apps/server/src/domains/git/index.ts:480-486` always forces a fresh read and is the only caller outside
  `git.summary`'s own `refresh` nonce path.
- `invalidate(repoKey)` bumps the generation counter; the next `topology()` call rediscovers.
  `clear()` drops everything (Project authorization changes).
- An LRU of 256 entries (`MAX_TOPOLOGIES`) bounds retained topologies; the oldest entry is evicted
  on overflow, along with its `rootIndex` mappings.
- Discovery never implies authorization: unauthorized worktrees are visible here for Workbench
  candidate flows, but `GitRepoService` still filters worktrees against approved Project roots
  before they enter a summary (`apps/server/src/domains/git/repo.ts:479-499`).

## Status snapshot lifecycle

`apps/server/src/domains/git/status.ts` — `RepoStatusStore<Status>` is generation-keyed per canonical worktree
root. `status(rootPath, load)` reports one of three outcomes, all counted per-summary in the
`SummaryTrace` (`apps/server/src/domains/git/summary-trace.ts`, `statusFresh` / `statusJoined` / `statusCoalesced`)
and rolled into the `git.summary` log event:

- **fresh** — no entry exists at the current generation; this call becomes the producer.
- **joined** — a production for the current generation is in flight; this call awaits the same
  promise instead of spawning `git status` again.
- **coalesced** — a settled snapshot already exists at the current generation; it is returned with
  no Git spawn at all.

**Stale-write guard and trailing coalescing.** A generation bump can land while a production is
still running. `produce()` checks the store's current generation against the entry's generation
after `load()` resolves; if the store advanced, the in-flight production re-runs once more at the
newest generation instead of handing consumers a snapshot that already predates the change that
superseded it. Because `entry.generation` is advanced before the recursive call, a burst of bumps
during one production coalesces into at most one extra load — this is per-repository trailing
coalescing, not a bump-per-load replay. A failed production is never cached: the entry is removed
from the store on error so the next consumer retries instead of replaying a rejection.

`bump(rootPath)` advances the generation (file write, Git metadata change, explicit refresh).
`evict` / `retainOnly` release snapshots for roots no Session references anymore.

## Metadata watcher

`apps/server/src/domains/git/metadata-watcher.ts` — `GitMetadataWatcher` opens exactly one `@parcel/watcher`
subscription per repository's common Git directory (`repoKey`), covering the commonDir itself and
every linked worktree's `worktrees/<name>` entry underneath it. This is the only place `.git`
content is watched; the general Project file watcher continues to exclude `.git` entirely, and raw
`.git` paths never leave this module — callbacks only carry `repoKey` and worktree root strings.

`classifyGitMetadataPath(relativePath)` (exported, unit-tested directly) turns one path change into
a `GitMetadataChange`:

| Relative path                                           | Classification                                  |
| ------------------------------------------------------- | ----------------------------------------------- |
| `HEAD`, `index`, `*_HEAD` (e.g. `MERGE_HEAD`)           | `status`, scope `worktree` (primary worktree)   |
| `worktrees/<name>/HEAD`, `.../index`, `.../*_HEAD`      | `status`, scope `worktree`, `gitDirName=<name>` |
| `refs/**`, `packed-refs`                                | `status`, scope `shared` (all known roots)      |
| `config`, `info/exclude`                                | `topology`                                      |
| `worktrees/<name>` (top-level add/remove), `.../gitdir` | `topology`                                      |
| `objects/`, `lfs/`, `sockets/`, `hooks/`, `logs/`       | ignored                                         |
| `*.lock`, `locked`, `.watchman-cookie*`, `fsmonitor*`   | ignored                                         |

Ignoring `objects/` and lock/cookie churn keeps a plain `git status` (which touches
`index.lock` under `GIT_OPTIONAL_LOCKS=0`) from becoming a refresh storm. A `worktrees/<name>`
change resolves to a worktree root by reading that worktree's `gitdir` file (a plain filesystem
read, not a Git spawn) and caching the result per group; resolution runs fire-and-forget so a slow
readback never blocks draining the next native event batch.

If the native subscription fails to start, `activatePollingFallback` polls `HEAD`, `index`,
`packed-refs`, `MERGE_HEAD`, and the `worktrees` directory's mtime/size signature every 5 seconds
(`POLL_FALLBACK_INTERVAL_MS`) and degrades to the same `onStatusChanged` / `onTopologyChanged`
callbacks. The 16-group recency limit (`MAX_WATCHED_REPOSITORIES`) evicts only groups no live
Session references. Active child repositories retain their watches; the shared WatchHub bounds
native subscriptions and falls back to polling at capacity. Shutdown waits for pending native
registration and disposal, and late completions compare entry identity before retaining handles.

## Repository-identity invalidation (`git.changed`)

Every projected repository registers its own canonical common Git directory, including submodules
and nested repositories. Submodule metadata under a parent's `modules/` directory belongs to the
child's subscription and must not be attributed to the parent. Git can report an absorbed
submodule's metadata directory as its primary worktree; topology discovery resolves its actual
checkout through `rev-parse --show-toplevel`. The watcher uses the topology's primary root, never
the currently selected linked worktree, and shared ref events include all known worktree roots.
Session projections retain every participating repository key so closing a sibling Session cannot
detach a child watcher that is still in use.

`apps/server/src/domains/git/change-tracker.ts` — `GitChangeTracker` owns the Session ↔ repository mapping
behind the `git.changed` Server event (`packages/protocol/src/registry/events.ts`). Each summary
registers, via `registerSession`, the canonical roots it projected for one Session
(`registerGitProjection`, `apps/server/src/domains/git/projection.ts`). A generation bump —
`scheduleStatusChanged(roots)` from a working-tree write or `observeMetadataStatus`, or
`scheduleTopologyChanged(repoKey)` from `observeMetadataTopology` — adds affected roots to a
pending set and debounces a flush by 150ms (`CHANGE_EMIT_DELAY_MS`), folding a burst of bumps
(rapid Agent writes, a rebase touching many refs) into one event.

The flushed event carries only opaque identifiers: `repositoryIds` (via `computeRepoId`, a
truncated SHA-256 of the root path, never the path itself), `sessionIds` of every Session whose
projection includes one of the changed roots — including sibling Sessions of other Workbench
Projects — and `scope: 'status' | 'topology'`. This removes dependence on the Renderer's Session
`staleTime` window for correctness: a sibling Session referencing the same repository converges
immediately instead of waiting out its cache.

`mapChangesToRoots` attributes a Session-relative changed path to the _deepest_ matching known root
(`session.roots` sorted longest-first), so a write inside a nested repository or submodule bumps
only that repository, not its parent.

## Repository summary production and bounded projection

`apps/server/src/domains/git/repo.ts` — `GitRepoService.produceSummary` is the only path that assembles a
`GitSummary`: it reads the shared topology (zero Git spawns when cached), filters worktrees to
approved Project roots, produces/joins/coalesces status snapshots through `RepoStatusStore`, then
discovers and status-snapshots child repositories (submodules, nested repos) with a
generation-keyed `childCache` bounded to 256 entries (`MAX_CHILD_CACHE_ENTRIES`).

Every Git command spawned on behalf of one summary is funneled through `tracedGit`, which
increments a `SummaryTrace.commandCount`; the trace also tracks `worktreeListed`,
`worktreeApproved`, `childRepositories`, and the fresh/joined/coalesced status counts. This is what
the `git.summary` boundary log event (`loadSummary`, `apps/server/src/domains/git/repo.ts`) reports
instead of leaving attribution to individual `git.command` records — fields: `durationMs`,
`commandCount`, `worktreeListed`, `worktreeApproved`, `childRepositories`, `fileCount`,
`generation`, `truncated`, `isRepository`, `outcome`, `reason` (`'request' | 'refresh'`), `requester`
(the closed entry-point enum `GitSummaryRequester`: `renderer`, `extension`, `overview`, `repository`,
`discard`, `projectStatus`, `pullRequests`, `terminal`), plus the per-status outcome counters.

**Production log volume.** `GitSummaryTelemetry` (`apps/server/src/domains/git/summary-telemetry.ts`)
is the only writer of `git.summary` records and owns their level
([issue #604](https://github.com/tjx666/caxri/issues/604)). A production (`outcome: fresh`) is written
at `info` only when its result differs from the previous one for that Session and carries
`changed: true`; a repeat is written at `debug` with `changed: false`, so a steady-state watcher storm
no longer fills the 5MB `server-core` generation. The comparison is a per-repository fingerprint of
id, kind, branch, head, ahead/behind, additions/deletions, `changedFileCount`, `truncated`, and a
SHA-256 of the sorted `path|status` file list — compared in memory, never written, so a same-count
change to which files are dirty still counts as a transition. `joined` and `queued` records are
always `debug`. Volume is restored by one `git.refresh_summary` record at `info` per Session per
60-second activity window: `refreshes`, `changed`, `repeated`, `joined`, `queued`, `commandCount`, the
three status counters, `totalDurationMs`, `maxDurationMs`, `durationMs` from the first to the last
counted refresh (idle time after a burst is not included), `reason*` counts, and `requester*` counts
of productions only. Windows close lazily on the next refresh after they elapse, on Session eviction
(`evictSessions`, including a production that settles after eviction), and on `GitService.close()`;
there is no timer. Production Server Core always logs at `info`
(`apps/server/src/core/process.ts`), so a log reader sees every _changed_ production and the
per-window aggregate, not every production; the startup benchmark's `gitSummariesFresh` therefore
counts changed productions and does not observe an identical restore snapshot. Refresh volume,
including repeated productions and `maxDurationMs`, is visible only in `git.refresh_summary`, so a
slow production that changed nothing shows up there rather than as its own `info` record.
`statusCoalesced` counts status reads served from the cached snapshot inside one production; a
forced production re-reads status, so it is expected to be `0` on the refresh path.

**Summary coalescing and the refresh nonce.** `GitRepoService.summary` single-flights per
`sessionId#sessionGeneration`; the `refresh` nonce is deliberately not part of the key
([issue #584](https://github.com/tjx666/caxri/issues/584)). A plain read joins whatever producer is in
flight. A forcing nonce that arrives mid-flight queues exactly one trailing forced run that starts
after the current producer settles, and every further force during that window shares it, so a
Session never runs two Git batches concurrently while a user refresh still observes state that
postdates the click. On the Extension side, `GitProvider` only advances its Server-facing nonce for
a user-initiated refresh (the panel's Refresh, Sync, and Discard actions through `executeAction`,
and the `caxri.git.refresh` palette command through `forceRefresh`; both advance the nonce via
`requestForcedRefresh`); watcher-driven `git.changed` and active-context re-reads reuse the previous
nonce and join the Server's current generation. A re-read that carries the forcing nonce while its
trailing run is still queued waits for that run instead of joining the pre-click producer.
`git.pullRequestChanges` has no last-seen-nonce memory (any nonzero `refresh` bypasses its cache),
so the provider sends the nonce there once per user action and `0` on every later re-read. A force
that waits behind the in-flight producer logs a `debug` `git.summary` record with `outcome: queued`
(`shared: true` when it joined an already queued run).

**Bounded working-tree projection.** `loadStatus` parses `git status --porcelain=v2 -z
--untracked-files=all` into `parsed.files`, computes `changedFileCount` as the _true_ count, and
truncates the transported `files` array at `MAX_GIT_STATUS_FILES` (2,000,
`packages/protocol/src/domain/git.ts`) with `truncated = changedFileCount > MAX_GIT_STATUS_FILES`.
`changedFileCount` is authoritative on a truncated snapshot; otherwise it is the post
child-repository-filtering visible file count, so every consumer of one generation reports the same
number. The controlled Source Control surface
(`apps/desktop/src/renderer/src/features/view-containers/source-control/source-control-provider-section.tsx`) renders
an explicit `Showing the first N of <changedFileCount>` notice when `truncated`; already-listed
files remain fully diffable.

**`git.summary` vs `git.overview`.** `git.overview` (`GitService.overview`,
`apps/server/src/domains/git/index.ts`) awaits the same `summary()` producer and strips `files` from
each repository via a rest-omit projection — it never triggers a second `git status`. The Status
Bar (`apps/desktop/src/renderer/src/features/status-bar/status-bar.tsx`) queries `git.overview` exclusively so
branch/count rendering never pulls the full `files[]` IPC payload into the Renderer, while staying
on the same snapshot generation the Source Control provider reads through `git.summary`.

**Reading a root nobody watches.** The Project file watcher follows only the selected Session, so a
plain working-tree write in any other Session's root never bumps that root's status generation, and
a cached read keeps returning the snapshot from when the user switched away. `git.overview` therefore
accepts `refresh: true`, which runs the same forced `refreshSummary` path `mobile.changes.list` uses.
The Session hover card's `Changes` row
(`apps/desktop/src/renderer/src/features/primary-sidebar/hooks/use-session-changes.ts`) is the
Desktop reader: it sends `refresh: true` only for a Session whose Workbench Root differs from the
selected Session's, reads only while its card is open, and lets one card read at a time. A forced
production announces itself with `git.changed`, so the Renderer's `git.changed` sweep skips
`refresh: true` overview keys; otherwise the open card would refetch, force, and announce again in a
loop. Those keys rely on their 30-second `staleTime` instead ([issue #859](https://github.com/tjx666/caxri/issues/859)).

## Per-file line counts

Each snapshot file carries optional `additions`/`deletions`
(`apps/server/src/domains/git/numstat.ts`). Tracked files come from the same
`git diff --numstat -z --no-renames HEAD` the repository totals already ran, with a renamed file's
old-path deletions folded into it. `git diff` cannot see an untracked file, or any file of an unborn
repository, so those are counted from disk through the shared working-file read semaphore, capped at
200 files and 1 MiB each; a file past the cap omits both counts rather than showing a false zero. The
repository `additions`/`deletions` totals stay tracked-only, so the Status Bar and project status keep
their meaning. Commit details and pull-request changes attach the same per-file counts from their own
numstat reads. The Git extension publishes them as `SourceControlResource.lineStats`, the Source
Control tree shows them on each file row and sums them into every directory row, and mobile Changes
reads them from the snapshot instead of running its own numstat.

## Measurement contract

`apps/server/src/domains/git/index.ts` — `GitService.git()` wraps every `execFile('git', …)` call with a
bounded `AsyncSemaphore` (`MAX_CONCURRENT_GIT_COMMANDS = 8`, unchanged) and logs `git.command` with
`queueMs` (time spent waiting for a semaphore slot) split from `execMs` (actual process wall time),
plus `operation` (argv[0], or `argv[0].subcommand` for `worktree`/`remote`/`stash`/`submodule` —
`classifyGitOperation`) and a non-reversible `repository` hash (`hashRepoPath`, SHA-256 of the cwd,
truncated). No source content, Terminal output, or raw filesystem path is logged. Command failures
log `git.command_failed` with the same fields. The `git.summary` boundary event (see above) is the
authoritative measurement for one summary's full wall time and command count; the startup benchmark
asserts against it rather than the last `git.command` record.

## Lifecycle and cleanup

- `GitRepoService.evictSessions` (`apps/server/src/domains/git/repo.ts`) drops per-Session projections
  from the tracker, prunes `refreshNonces`, retains only status snapshots and child-cache entries
  for roots still referenced by a live Session, and asks the metadata watcher to `retainOnly` the
  still-referenced repository keys.
- `GitService.evictSessions` / `GitService.close` (`apps/server/src/domains/git/index.ts:538-551`) additionally
  clear Pull Request state and, on `close`, stop the change tracker's pending flush timer and
  `unsubscribe` every metadata watcher.
- Project/Session deletion or authorization changes flow through this same eviction path — never a
  separate ad hoc teardown — keeping the Server file-descriptor gate intact (watcher subscriptions
  are the scarce resource, bounded at 16 groups).

## Non-goals

- No libgit2, nodegit, isomorphic-git, or Renderer/native Git implementation — all discovery and
  status reads go through structured `execFile('git', …)` argv.
- No TTL or time-based expiry backs branch/index/working-tree correctness. Every refresh path is a
  generation bump driven by an actual write, metadata-watcher classification, or an explicit
  `refresh` nonce — never elapsed time.
- The general Project file watcher never recurses into `.git`; the Git metadata watcher is a
  separate, narrow-scope subscription, and raw `.git` paths never reach `files.changed`, the
  Renderer, or diagnostics/logs.
- Topology discovery does not imply authorization. An unauthorized linked worktree can appear in
  `RepoTopologyRegistry` (for Workbench Root candidate flows) without being reachable through Git
  SecondarySidebar, diff, history, Files, the CLI, or an Agent Endpoint — `GitRepoService` re-checks
  approved Project roots on every summary.
- No increase to the global Git concurrency limit (`MAX_CONCURRENT_GIT_COMMANDS = 8`); reduced
  command counts are the mechanism, not added parallelism.
