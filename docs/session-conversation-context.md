# Session conversation context

Durable record of how Caxri reads a Session's own Agent conversation to answer three questions the
repository alone cannot: _which worktree is this Session actually working in_, _which Linear issue
is this branch about_, and _which pull request did this Session deliver_. Source lives in
`apps/server/src/domains/agents/transcript-session-context.ts` and
`apps/server/src/domains/agents/transcript-pull-requests.ts` (the scanners),
`apps/server/src/domains/session-context.ts` (the shared reader), and
`apps/server/src/domains/project-status-linear.ts` (candidate precedence).

## The surfaces

| Surface                               | Question                                  | Read through             |
| ------------------------------------- | ----------------------------------------- | ------------------------ |
| Workbench Root picker's leading group | Which worktrees did this Session visit?   | `session.workbenchRoots` |
| Status bar's Linear chip              | Which issue is this branch delivering?    | `projectStatus.overview` |
| Session pull request                  | Which pull request did this Session open? | `session.pullRequests`   |

The Session pull request is owned by `SessionPullRequestService`; the status bar and the Status
panel follow its answer instead of asking by branch (see
[External delivery-status queries](external-status-quota.md#which-pull-request-a-session-delivers)).

Neither surface added a query or a poll. The picker's query already ran only while the menu was
open, and the status bar overview already refreshed on a fixed 60s interval; the conversation read
rides along with both.

## What the scanner takes, and what it refuses

One pass over a transcript produces three bounded, most-recently-named-last lists: working
directories, branch names, and Linear markers. The same pass feeds the pull request scanner, which
keeps only the pull request a `gh pr create` returned and the one the Agent last linked in its own
prose.

It reads **prose** — what the user typed and what the Agent wrote — and **tool invocations** — a
shell command line, a `workdir` argument, a `cwd` field. It deliberately does **not** read tool
_output_. A `git worktree list` or a `git log` dump would otherwise backfill the lists with paths and
identifiers nobody in the conversation chose, and the most recently _printed_ worktree is not the one
the Session is working in. The single exception is the result of a `gh pr create` the Agent itself
ran: that output is the pull request this Session delivered.

It also strips harness-injected envelopes before looking for issue markers: `<INSTRUCTIONS>` (Codex's
`AGENTS.md` injection), `<system-reminder>`, `<user_instructions>`, hook output, and command
envelopes. These routinely quote an issue identifier as a _format example_ — a contributor guide that
documents "reference issues as `ABC-123`" would otherwise bind every Session in that repository to
`ABC-123`.

## The security invariant

**A transcript is a filter over what Git already reported, never a source of authority.**

A directory the Agent printed reaches the user only when live worktree topology independently
reported it, `lstat` confirmed it is a real directory and not a symlink, and discovery produced an
option for it. `rankConversationWorktrees` then reorders those options and nothing else: it sets
`conversationRank`, which the Renderer uses to group. It cannot introduce a root, cannot change an
option's `authorization`, and cannot survive the worktree being removed. A recommended worktree with
no Project still shows `Authorize` and still goes through the ordinary authorization path.

The group is offered only while the Session is bound to the repository's **main** worktree — the case
where the Session has not chosen yet, which is the whole point — and never recommends the main
worktree itself.

Nothing from the transcript is retained beyond the bounded clue lists: no prompts, no Agent output,
no command results. A diagnostics export or a crash dump cannot leak conversation content through
this path.

## Cost model

Scanning is **incremental and shared**. `SessionContextService` keeps one cursor per transcript path
and reads only the bytes appended since the previous visit, so a first visit to a long transcript pays
once and the status bar's minute poll costs a `stat` plus whatever the Agent wrote in that minute. A
transcript that shrank below the cursor (a rewritten or rotated file) resets and rescans from zero.
Every consumer joins the same in-flight read through `SingleFlight`, so a user opening the picker
during a status-bar refresh does not double the work, and the sidebar's pull request sweep keeps no
transcript cursor of its own.

Per line, a record carrying neither prose nor a command is answered from the raw text with two regular
expressions and no `JSON.parse` — which is the overwhelming majority of a real transcript
(reasoning records, token accounting, tool results).

## Which Linear issue the status bar names

Three sources can name an issue, and they are not equally trustworthy:

1. **The pull request description** — a `linear.app` URL or a `Fixes ABC-1` marker. Someone stated the
   link on purpose. This costs nothing extra: `PULL_REQUEST_FIELDS` already fetches `body` into the
   shared `GitHubPullRequestStore` record the overview reads.
2. **The branch name** — `feat/abc-42-router-monitoring`, the shape Linear's own "copy branch name"
   produces.
3. **The conversation** — a marker or URL in this Session's transcript.

The first identifier wins its position, so a branch repeating what the pull request already said does
not produce a second chip or demote the pull request's statement.

### The team-key allow-list

Sources 2 and 3 yield **bare** markers, and a bare `ABC-42` is shaped exactly like `UTF-8`,
`RFC-2119`, `CVE-2024`, and `GPT-4`. Caxri resolves this with one query per workspace per six hours:

```graphql
query TeamKeys {
  teams(first: 250) {
    nodes {
      key
    }
  }
}
```

The workspace's real team keys settle every candidate at once, and settle them correctly. Asking
Linear about each candidate instead would spend a query to learn that a text encoding is not an
issue.

An unavailable allow-list — no `linear` CLI, an unauthenticated workspace, a paused quota — yields an
**empty set**, which admits nothing. "Unknown" must narrow, never widen. It is retried after five
minutes rather than six hours, so authenticating fixes the chip in minutes.

The allow-list is fetched only when a low-precision source actually has a candidate waiting on it, and
a short list of prefixes that are never a team — `UTF`, `RFC`, `CVE`, `GPT`, `SHA`, `AES`, `ISO`,
`HTTP`, `MD`, `WCAG`, `ARIA` — is rejected before that check rather than by it. Without that, ordinary
prose (`SHA-256`, `RFC-2119`) and ordinary branches (`release-1.2`, `feat/add-2fa`) would each send a
real query to the user's workspace just to learn they are not issues. The same list runs at capture
time in the scanner, so a burst of false markers cannot evict the one real identifier the user typed.

A conversation reference that arrived as a full `linear.app` URL carries its own workspace slug and
skips the gate: the URL already proved the workspace.

The Status panel's own Linear rows are unchanged — they read pull request bodies only, with no
allow-list gate, exactly as before.

### Resolution and degradation

Only the **leading** candidate is resolved to a title, workflow state, and URL; the status bar shows
one issue and counts the rest, so resolving the tail would spend a query per refresh on text nothing
renders. A leading candidate that cannot be resolved degrades to the bare identifier: the chip prints
it, is not clickable, and says so in its accessible name.

Issue records live in `LinearIssueStore` (`apps/server/src/domains/external-status/linear.ts`), shared
with the Status panel and governed by the same quota circuit breaker as every other `gh`/`linear`/`vc`
spawn — see [external delivery-status queries](./external-status-quota.md). Failures are cached too,
so a machine with no `linear` CLI does not spawn a doomed process once a minute per open Session.
