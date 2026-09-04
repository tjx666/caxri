# External delivery-status queries and quota governance

Durable record of how Caxri reads GitHub, Linear, and Vercel delivery metadata, and why every one of
those reads goes through a single Server-side owner. All source lives under
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

### One circuit per source

`ExternalStatusLimiter` (`limiter.ts`) wraps every `gh`, `linear`, and `vc` spawn. `git` is local and
free, so it bypasses the circuit entirely.

- **GitHub primary limit** — on a rate-limited failure, probe `gh api rate_limit` and pause until the
  GraphQL `reset` GitHub itself reports. The probe reads the REST bucket, a different budget from the
  GraphQL calls it reports on, so it never spends the quota it is protecting. Fallback when the probe
  fails: 15 minutes.
- **GitHub secondary (abuse) limit** — clears in seconds, not at the hourly reset, so it pauses for
  60s. See
  [GitHub's secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits).
- **Reserve** — before a `gh` call, at most once every five minutes, read the remaining GraphQL
  points. Below 100, pause until reset. Caxri is not the only thing on this account.
- **Linear and Vercel** report no reset time, so their circuits back off geometrically (60s → 120s →
  300s → 900s) and resets the ladder on the first success.
- A paused source fails immediately with the same `rate-limited` error kind the CLI would have
  produced. Surfaces keep rendering their last good snapshot because the store serves the stale
  record, not because the error is silent — a surface that has never loaded the pull request still
  reports the failure, which is honest: it genuinely has nothing to show.
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

## Interest is pull-based

There is no background poller. A record is only fetched when a surface actually reads it, so a key
nobody is looking at costs nothing: Linear and Vercel are still reached only from the Status panel's
`projectStatus.summary`, and never on behalf of a session that merely renders a sidebar badge. The
Renderer's polls (`session.pullRequests`, `projectStatus.overview`) are now snapshot reads whose
external CLI spend is entirely governed by the Server's TTLs and circuits.

"Pull-based" is not the same as "free while the window is open". `usePolledQuery` stops on a hidden
window, so a backgrounded Caxri really does spend nothing; a visible one still asks every 60s, and
the sidebar sweep covers every active Session rather than only the rows on screen. What the TTL and
the circuit control is how many of those reads reach a CLI.

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
