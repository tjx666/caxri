---
kind: living
status: current
---

# Terminal reference hover previews

Durable record of the hover card that appears over a commit sha or a GitHub reference printed in a
Terminal: what it shows, what it is allowed to read, and why each boundary is where it is.

A Terminal is full of identifiers that are meaningful only if you already know them. `f36a02a` in
`git log` output, `tjx666/caxri#445` in a CI summary, a bare `#912` an Agent just wrote — each one
answers a question the user has to leave the Terminal to ask. The affordance hint already told them
the link was clickable; the card tells them whether it is the link they want before they spend a
pane on it.

## What the user sees

Hovering a detected reference opens the same popup that already showed `⌘ click to …`, now with the
reference's own metadata above that affordance line:

| Reference kind       | Card contents                                                              |
| -------------------- | -------------------------------------------------------------------------- |
| Commit sha           | subject, `repository · shortSha`, author, relative age, `+N -M in K files` |
| GitHub issue / PR    | title, the configured link detail, state and number, author, relative age  |
| Configured link rule | the rule's own label and detail only — no request is made                  |
| File path            | the existing affordance hint only                                          |

The affordance line stays last, so the card never costs the user the instruction they were reading.
`Esc` dismisses it; scrolling the Terminal dismisses it; moving the pointer off the link dismisses
it. Everything remote renders through `textContent`, never markup — a card is built from program
output and a repository the user does not control.

## Only two kinds of reference are worth a read

`terminalReferencePreviewRequest` (`apps/desktop/src/renderer/src/features/terminal/terminal-reference-preview.ts`)
decides what a hover may ask about, and answers `undefined` for everything else:

- A **commit** reference, when the matched text is 7–40 hexadecimal characters.
- A **GitHub** issue or pull request, when the link target is a `github.com/<owner>/<repo>/(issues|pull)/<number>` URL.

A configured reference rule (`terminal.references` in Settings) is deliberately excluded. The rule
already carries the label and the detail its card shows, so hovering one costs nothing; asking a
tracker for a title it cannot know we want would spend a request on an unchanged card.

File links are excluded for the same reason from the other side: resolving one is a Project-wide
suffix search, which is the right price for an explicit click and the wrong price for a pointer
passing over a stack trace.

## The Renderer never asks twice for the same answer

`TerminalReferencePreviewStore` sits between the hover and the protocol:

- **One read per reference.** Concurrent hovers over the same reference — two panes showing the same
  sha, a pointer that left and came back — join one in-flight read.
- **Cancellation is real.** The read travels on `caxri.requestWithSignal`, so a pointer moving on
  sends `requests.cancel` rather than abandoning a response the Server is still producing. The
  signal is aborted only when the _last_ waiter leaves.
- **A departing hover is answered immediately.** `load` races the Server's answer against the
  hover's own departure. Waiting for the read to settle first would hold a card nobody can see, and
  would let a slow read reorder itself in front of the next hover.
- **Bounded memory.** 64 entries, least-recently-stored evicted, 60s TTL for a real card and 15s for
  an `unavailable` one — a blank card is usually a transient state, and re-asking after a quarter of
  a minute is how it recovers without a restart.

A rejection is never propagated to the popup. The store returns `undefined` and the basic affordance
card stays on screen, because the most common rejection is the cancellation the store itself just
requested.

## The Server decides what a hover is allowed to read

`terminal.reference.preview` (`apps/server/src/domains/git/reference-preview.ts`) takes a Terminal ID
and a reference, and resolves the Project from the Terminal — the Renderer cannot submit a
repository, a root, or a cwd.

**A commit** resolves through the same abbreviation resolver `⌘ click` uses. An abbreviation matching
commits in two of the Session's repositories returns `ambiguous` rather than picking one, which is
the answer the click path already gives. The commit body is truncated at the Server; the card shows
two lines and the rest never crosses the wire.

**A GitHub reference is read only for a repository the Session already has.** This is the load-bearing
restriction. A Terminal renders whatever a program writes, and hovering is involuntary in a way
clicking is not, so `attacker/repo#1` scrolling past the pointer must not be able to steer an
outbound request at a repository of its choosing. The link still opens anywhere on an explicit
`⌘ click`; only the unattended read is constrained. An unknown repository returns `not-found` without
spending a request.

### Nothing rejects

Every "nothing to show" case returns an `unavailable` card with a closed reason, never a rejected
request — a hover the user did not ask for must not raise a toast they then have to dismiss. The
reasons are separately actionable on purpose:

| Reason              | What the operator does about it        |
| ------------------- | -------------------------------------- |
| `cli-missing`       | install the GitHub CLI                 |
| `not-authenticated` | `gh auth login`                        |
| `rate-limited`      | wait for the quota to reset            |
| `ambiguous`         | use a longer abbreviation              |
| `not-found`         | nothing — the reference does not exist |
| `failed`            | read the logs                          |

The failure is logged as that reason enum, never the CLI's message: a blank card has to stay
countable by cause, and `gh` output can carry a repository path or a token hint that must never
reach a log.

## Cost

A hover over a commit is a local Git read admitted through the Git command semaphore, so a burst of
hovers cannot outrun the concurrency budget the rest of the Git domain respects.

A hover over a GitHub reference goes through `GitHubReferenceStore`, a separate owner on the
external-status hub with its own cache and its own budget. See
[one projection per reference](./external-status-quota.md#one-projection-per-reference) for why it
does not share records with the pull-request store and why it reads REST rather than GraphQL.

## Non-goals

- No preview for configured reference rules, file paths, or arbitrary URLs.
- No body rendering beyond a couple of truncated lines; the card is a decision aid, not a reader.
- No prefetch. A card is produced for a reference the pointer is on, never for the ones around it.
