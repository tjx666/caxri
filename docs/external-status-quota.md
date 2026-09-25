# External delivery-status queries and quota governance

Durable record of how Caxri reads GitHub, Linear, Vercel, and LobeHub delivery metadata, and why
every one of those reads goes through a single Server-side owner. All source lives under
`apps/server/src/domains/external-status/`.

## The problem this replaced

Four surfaces asked GitHub for the _same_ pull request through four independent code paths, with no
shared cache and no shared failure state:

| Surface                  | Server operation         | Command                                                                   |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Status Bar delivery chip | `projectStatus.overview` | `gh pr view <branch> --json number,title,url`                             |
| Status panel             | `projectStatus.summary`  | `gh pr view <branch> --json …statusCheckRollup`                           |
| Sidebar delivery badges  | `session.pullRequests`   | `gh pr view <number>` / `gh pr list --limit 10 --json …statusCheckRollup` |
| Source Control PR diff   | `git.pullRequestChanges` | `gh pr view --json …baseRefOid,headRefOid`                                |

`SingleFlight` only coalesces the _same_ method and key, so those four never joined. Worse, a
rate-limited response was retried on a **shorter** timer than a successful one (30s failure TTL
against a 60s success TTL), from every surface at once, in every open worktree Server. The GitHub
GraphQL budget is shared with the user's own shell, the Agent's `gh` calls, and editor extensions on
the same account, so the app's recovery behaviour was what kept the account limited.

## Branch publication in Project Status

The branch row compares the local branch with the **same-named branch on origin**. It does not
claim to describe a differently named upstream, another remote, or the configured push destination.
Server reads the branch ref through a quota-governed GitHub GraphQL query and caches the remote
commit per owner, repository, and branch for five minutes (`RemoteHeadCache` in
`project-status-branch.ts`). Before the cache, this query ran on every summary refresh — every 20
seconds while a pull request's checks run — and was ~900 of the ~1,100 `gh` calls Caxri made per
hour. Local tracking refs are only cache invalidation inputs: a stale ref never proves that a remote
branch exists, but a moved ref (a local push or fetch) misses the cache immediately. A manual
refresh always queries again, and a failed lookup is never cached. Only a push from another clone or
a branch deleted on GitHub waits out the TTL. Git changes invalidate the tree, including a local push
that leaves HEAD unchanged. The Status Bar overview does not make this extra query.

The row shows `Not on origin`, `Synced`, or `↑N` / `↓N` commit differences. Counts compare captured
immutable commit IDs only when the remote commit and complete history are locally available.
Otherwise `On origin` confirms existence without claiming that every local commit has been pushed.
No fetch, network Git command, or repository mutation is performed. The tooltip names the compared
branch and check time; results are snapshots governed by the existing summary TTL and manual refresh.

Local identity costs one `git` process per repository per round. HEAD and the branch come from the
`git.summary` snapshot the refresh already holds, and origin's URL and default branch are cached per
repository root for five minutes (`RepoRemoteCache` in `project-status-branch.ts`); a manual
refresh reads them again. Only the same-named tracking ref is read every round, because a push or
fetch moves it. Vercel costs two `vc api` calls per repository: HEAD's preview is taken from the
branch deployment list, and only a HEAD that list does not carry gets its own query.

An inaccessible repository, malformed response, authentication failure, or offline refresh shows
`Unknown` and suppresses the branch link. Only an accessible repository with a null ref proves
absence. Publication and PR errors share one GitHub error presentation. Detached HEAD, no commits,
no origin, and unsupported non-GitHub origins are handled without a remote query. A branch link is
available only after remote existence has been confirmed.

## The hub

`ExternalStatusHub` (`hub.ts`) is constructed once in `createRootServices` and injected into
`GitService`, `ProjectStatusService`, and `SessionPullRequestService`. It owns two things.

### One projection per pull request

`GitHubPullRequestStore` (`github.ts`) keys records by pull-request identity (`owner/repo#number`).
A branch-shaped lookup resolves through a `refAliases` index onto the record it produced, so the
Status Bar asking by branch and the sidebar sweep asking by number join one fetch rather than
spending two queries on one pull request.

Every read requests the same field union — the superset the four surfaces need, including
`statusCheckRollup`, the most expensive field in GraphQL points. When several surfaces are looking at
one pull request, fetching the union once and sharing it is cheaper than four narrower queries,
because the rollup was already being paid for by two of the four. The trade-off is real in the
opposite case: with only the Status Bar open, a read that used to ask for `number,title,url` now
pays for the rollup. Keeping the union and letting the TTL make it one query per pull request per
poll is the deliberate choice; splitting the store into cheap and full variants is not worth the
second cache.

- Presence is cached for 90s; absence ("this branch has no pull request", the common case for
  `main`) for 5 minutes, because re-asking costs a full query to learn nothing.
- The presence TTL is deliberately above the Renderer's 60s polls. At exactly 60s every poll landed
  just past expiry — `usePolledQuery` schedules the next request only after the previous one settles
  — so the shared record was refetched on every poll and shared nothing with itself.
- `maxAgeMs: 0` forces a refetch. Only an explicit user refresh passes it: the Status panel's refresh
  token and Source Control's `git.pullRequestChanges` refresh, which must see a force-pushed head.
- Window focus counts as that explicit refresh for the selected Session only. The Renderer calls
  `session.refreshDeliveryOnFocus`, and `DeliveryFocusRefresh` (`delivery-focus-refresh.ts`) forces
  the Status panel summary and then that Session's sidebar lookup, at most once per Session every
  15 seconds. Without it, a pull request merged in the browser kept showing as open for up to the
  settled TTLs above, because the Renderer's own focus refetch only reads these caches. The sidebar
  lookup accepts a shared record up to 5 seconds old, so it joins the Status panel's fresh fetch
  instead of querying the same pull request twice.
- A confirmed "no pull request" is cacheable. A transport, auth, or quota failure is **not** — it
  would otherwise render as "no PR" until the TTL expired.
- A failed refresh serves the last known record rather than propagating the error, and leaves
  `fetchedAt` untouched so the first read after recovery refetches. Without this, one rate-limited
  refresh replaces a good pull request with an error banner on every surface for the whole pause.
- The single-flight key is the lookup shape, not the repository. Two concurrent _first_ lookups of
  one pull request — one by branch, one by number — therefore still spend two queries; nothing can
  prove they are the same pull request until one answers. Keying by `owner/repo` would coalesce that
  case at the price of serialising genuinely different pull requests, which is what the sidebar sweep
  produces across Sessions. The miss heals immediately through the branch alias.

Branch discovery in `session-pull-requests.ts` still runs `gh pr list --head=<branch>`, but only for
identity (`number,state,isDraft`) and only five candidates. The selected pull request's checks then
come from the shared record. The previous `--limit 10` with `statusCheckRollup` multiplied one
query's cost by every candidate returned.

### One projection per reference

`GitHubReferenceStore` (`github-reference.ts`) answers a different question from the store above:
"what is `owner/repo#123`", not "what pull request does this branch have". It backs the Terminal
hover card described in [Terminal reference hover previews](./terminal-reference-preview.md), and it
deliberately shares no records with the pull-request store — a preview needs a title, not a check
rollup, and paying for a rollup on hover is the cost this store exists to avoid.

- One REST read (`gh api repos/<owner>/<repo>/issues/<number>`) answers both halves of the
  reference. Nothing in `owner/repo#123` says whether it is an issue or a pull request, and
  `gh pr view` and `gh issue view` each refuse the other's numbers — a CLI-shaped read would have to
  guess, fail, and retry, spending two processes on every issue. GitHub's REST issues endpoint
  covers pull requests too and marks them with a `pull_request` key.
- REST also draws on a **different budget** from the GraphQL points `gh pr view` and the sidebar
  sweep share, so a hover never competes with delivery status.
- A hit is cached for 10 minutes — far longer than the pull-request store's 90s, because an issue
  title changes rarely and a hover is an involuntary gesture. A miss is cached for 30 minutes: a
  reference that does not resolve is almost always a number that never existed, so re-asking buys
  nothing. Neither is cached forever, so a genuinely new issue becomes visible without a restart.
- Only a recognizable "no such issue" failure is cached as absence. A transport, auth, or quota
  failure stays uncached, or a temporary outage would be remembered as "this issue does not exist"
  for the whole TTL.
- The Server reads a reference only for a repository the hovering Session already has. That gate
  lives in `reference-preview.ts`, not here, and is the reason untrusted Terminal output cannot
  steer an outbound request.

### One circuit per source

`ExternalStatusLimiter` (`limiter.ts`) wraps every `gh`, `lh`, `linear`, and `vc` spawn. `git` is local and
free, so it bypasses the circuit entirely.

- **GitHub primary limit** — on a rate-limited failure, probe the GraphQL `rateLimit` self-query
  (`gh api graphql -f query='query { rateLimit { limit remaining used resetAt } }'`) and pause until
  the `resetAt` GitHub itself reports. GitHub does not bill a query whose only field is `rateLimit`,
  so the probe never spends the quota it is protecting. REST `/rate_limit` is deliberately not used:
  for the token class `gh` holds, its `resources.graphql` entry is a constant placeholder (`used` 0,
  `remaining` equal to `limit`, `reset` sliding with the clock), which is why the reserve never fired
  before #917. Fallback when the probe fails: 15 minutes.
- **GitHub secondary (abuse) limit** — clears in seconds, not at the hourly reset, so it pauses for
  60s. See
  [GitHub's secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits).
- **Reserve** — before a `gh` call, at most once every five minutes, read the remaining GraphQL
  points. Below 100, pause until reset. Caxri is not the only thing on this account.
- For **Linear, Vercel, and LobeHub**, Caxri uses a conservative geometric backoff when no usable reset time is available
  (60s → 120s → 300s → 900s) and resets the ladder on the first success.
- A paused source fails immediately with the same `rate-limited` error kind the CLI would have
  produced. Surfaces keep rendering their last good snapshot because the store serves the stale
  record, not because the error is silent — a surface that has never loaded the pull request still
  reports the failure, which is honest: it genuinely has nothing to show.
- That error also carries the circuit's own `resumeAt` as `ExternalStatusCliError.retryAt`, both when
  the pause pre-empts the call and when the provider is the one that reported the limit. It travels
  on the error rather than through a limiter reference threaded into every domain, because the
  deadline is a property of the failure, not of the caller. It reaches the UI as the optional
  `retryAt` on `ProjectStatusError`; see
  [the deadline crosses the protocol](#the-deadline-crosses-the-protocol).
- The pause is written to `~/.cache/caxri/external-status-limit.json` and merged back in at most
  every 5s, so parallel worktree Servers and a second window share one pause instead of each
  rediscovering it. Only the later resume time survives, on both read **and** write: `persist()`
  re-reads the file and writes the per-source maximum, because a blind overwrite would erase a pause
  a sibling recorded for a different source inside this process's reload window. The merge is not
  atomic across processes; it narrows the lost-update window to the read-write pair, which is all a
  best-effort hint needs. This mirrors the cross-worktree single-poller election `scripts/watch-ci.ts`
  already uses.

Structured logs use `external_status.paused`, `external_status.resumed`, and `external_status.quota`;
they carry the source, the reason, and the pause duration, never a repository, branch, or issue.

## The deadline crosses the protocol

A pause the user cannot see reads as a broken app: before this, every repository in the Project
Status panel carried its own red "GitHub CLI rate limited" block with a Retry button that could only
produce the same error, and the status bar said `PR unknown` for all eight unavailable reasons.

- `ProjectStatusError` carries `reason: 'network' | 'rate-limited' | 'tls'` on a `failure`, plus an
  optional `retryAt`. The discriminator is what lets a consumer tell an account-wide condition from a
  repository-specific one; `retryAt` is the circuit's `resumeAt`, in epoch milliseconds.
  `packages/extension-api/src/index.ts` mirrors this shape by hand — change both or extensions see a
  different contract than the Renderer.
- The Server owns the sentence. `projectStatusCliError` and `pullRequestUnavailable` both compose the
  full recovery copy, including the clock time from `retryTimeLabel`, so the panel row, the status
  bar tooltip, and the sidebar hover card cannot drift apart. `retryTimeLabel` refuses a deadline
  already in the past, because a cached failure snapshot outlives its own pause.
- The status extension coalesces `network` and `rate-limited` failures into root-level rows and hides
  them from the per-repository lists: they belong to the account or the machine, not to a repository,
  so repeating them once per repository was noise. Rate limits get one row per provider, since each
  budget resets on its own schedule. `tls` is not coalesced yet.
- A row whose `retryAt` is still in the future offers no action at all, and uses `hourglass` in the
  muted tone rather than a danger icon: Caxri recovers on its own, and the view's title bar still
  carries Refresh for a user who wants to try anyway. Once the deadline passes, the row's Retry
  returns — that check runs against the current clock, not the clock the snapshot was written on.
- The status bar chip names the reason (`PR rate limited`, `PR needs login`, `PR TLS error`, …) in
  `pull-request-status-label.ts`. `other` is the only reason still called `unknown`.

## Interest is pull-based

A record is only fetched when a surface actually reads it, so a key nobody is looking at costs
nothing: Vercel is reached only from Project Status summaries, and never on behalf of a session that
merely renders a sidebar badge. The one background reader is the delivery-failure watch (see
[Notifications](./notifications.md)): while delivery failure notifications are enabled it refreshes
each unarchived Session's summary every one to three minutes, deduplicated per repository and
branch, and it stops spending entirely when the setting is off. The
Renderer's polls (`session.pullRequests`, `projectStatus.overview`) are now snapshot reads whose
external CLI spend is entirely governed by the Server's TTLs and circuits.

`projectStatus.overview` reaches Linear only when a branch name or the Session's conversation
produced a plausible bare issue marker that needs the team-key allow-list, or when a candidate
survives that gate and has to be resolved. Prefixes that are never a team (`UTF`, `RFC`, `SHA`, and
the rest of the short list in `transcript-session-context.ts`) are rejected before the allow-list is
consulted, so a repository that never mentions an issue never spawns `linear` at all. Both readers
share `LinearIssueStore` (`linear.ts`), so the Status panel and the status bar never pay twice for
one issue. See [session conversation context](./session-conversation-context.md).

"Pull-based" is not the same as "free while the window is open". `usePolledQuery` stops on a hidden
window, so a backgrounded Caxri really does spend nothing; a visible one still asks every 60s, and
the sidebar sweep covers every active Session rather than only the rows on screen. What the TTL and
the circuit control is how many of those reads reach a CLI.

## Acceptance reports

A LobeHub acceptance report is the record of an independent reviewer running a change's checks and
reaching a verdict, so "did the tests pass" and "did acceptance pass" are different questions and
Project Status answers both. Caxri finds a report the same way it finds a Linear issue: from a link
in the pull-request body, and from one the Session's own conversation named. `acceptance-link.ts`
owns the URL grammar for both readers, including the `?r=` alias the app still emits for `?turn=`,
and a `/check/<id>` deep link, which resolves back to the report that owns it.

A link may pin a round. A pinned link keeps answering for that round after a later one runs, because
the person who pasted it was pointing at a specific result. An unpinned link follows the latest
round and says so (`12/12 · latest of 3`). `AcceptanceStore` (`acceptance.ts`) caches by report id
rather than by `(id, round)`: the round only selects which entry of an already-fetched bundle
answers, so watching three rounds of one report still costs one `lh acceptance view` spawn.

The status bar resolves only the leading report and renders the rest as bare links; the Status panel
resolves every candidate, capped at four per branch. A report Caxri recognized but could not read
stays visible as an inert row that still opens the link — `state: 'unknown'`, not an error block —
because a missing or logged-out `lh` should not make the reference disappear.

### One state, computed once

`ProjectStatusAcceptance.state` is reduced on the Server by `acceptanceProjectStatusState` and
shipped on the wire, exactly as `ProjectStatusDeployment.state` already is. The status bar renders
Lucide glyphs and the Status extension renders codicons, and the extension cannot call a protocol
helper at runtime without bundling zod into a self-contained extension — so the only way both
surfaces can be guaranteed to agree is for neither of them to decide.

The reduction has one non-obvious rule: **the round's verdict outranks the report's lifecycle**,
because the verdict is the newer fact. A report that moved to `repairing` after a `failed` round
reads as `failure`; `uncertain` reads as `pending`, not `neutral`, since it is unfinished rather than
inapplicable. Two cases run the other way and are equally deliberate: `delivered` + `passed` is
`pending` because it is still waiting on a person, and `rejected` + `passed` is `failure` because
the person's decision is the newest fact of all.

### The report id is never rendered and never logged

An acceptance id names a private record, tells a reader nothing, and would persist into a `warn`
record if it became an error's subject. It is therefore absent from every label, aria-label, and
tooltip line, and `projectStatusCliError` is given the literal subject `acceptance report` instead.
The id survives only inside the link the row opens.

## Failure back-off must never be shorter than success

`SUMMARY_FAILURE_CACHE_TTL_MS` and `session-pull-requests.ts`'s `FAILURE_TTL_MS` are both 5 minutes,
above their respective success TTLs. This is the invariant the original bug violated; keep it when
tuning either number.

## Non-goals

- No token handling, HTTP client, or API SDK in Caxri. Every read is the user's own authenticated
  CLI, launched with structured argv through the shared login-PATH boundary.
- No runtime cache sharing with editor extensions on the same account — they are separate processes.
  Only the pause file crosses the process boundary.
- No settings opt-in for GitHub polling. Caxri queries whenever a `github.com` remote exists; the
  circuit breaker, not a toggle, is what protects the account.

## Cancelled GitHub checks

Project Status preserves GitHub's `CANCELLED` conclusion as `cancelled`, shown with a muted
slashed-circle icon and a `cancelled` tooltip. Cancelled checks do not count toward failure badges
or delivery-failure notifications. The Session PR hover card reports `Checks cancelled`.

PR summaries prioritize actual failures, then running checks. Once every check is terminal, a
cancelled check remains visible but does not override another non-cancelled outcome; the summary is
`cancelled` only when cancellation is the sole outcome. The panel retains the records GitHub
supplies; it does not infer that similarly named checks replace each other or automatically rerun a
cancelled job.
