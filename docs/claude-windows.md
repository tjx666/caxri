---
kind: living
status: current
---

# Claude 5-hour windows

A Claude Pro or Max subscription meters usage in rolling 5-hour windows. A window starts with the
first request after the previous one ended, so a window that starts at 09:40 resets at 14:40, and
an idle stretch shifts every later reset. The Claude 5-hour window keeper starts each window on a
schedule instead, so the first reset of the workday lands at a time the user chose
(`First workday reset at`, default 10:00) and later windows follow back to back.

The keeper lives in Settings › Agents › Claude as **Claude 5-hour windows**. It is on by default
for a Pro account and off for Max and every other plan; the user's choice is kept per account
across restarts and plan changes.

## Schedule

- **Morning anchor**: `First workday reset at` minus five hours, in the local time zone. The
  default 10:00 puts the anchor at 05:00, so the window the keeper starts at 05:00 resets at 10:00.
  The anchor is recomputed on the local wall clock for each day, so it follows a time zone change
  and keeps its local time across a daylight saving change.
- **Renewal**: when a window resets, the keeper starts the next one a minute later, as long as the
  new window ends by the next morning anchor. The renewal that would cover the anchor (for the
  default, the one due around 01:00) is skipped and recorded as `renewal_skipped`, so the next
  day starts fresh at the anchor.
- **Real requests win**: when the user's own Claude request already started a window, the keeper
  sends nothing (`natural_window_started`) and renews from that window's reset.
- **Missed times**: when the Mac slept or Caxri was closed through a planned time, the first check
  after waking handles only the latest missed time, once (`missed_while_asleep`), and only while
  that window would still be running. It never replays every missed time.

The schedule math lives in `apps/server/src/domains/claude-windows/schedule.ts`.

## One request per window

Before each send the keeper writes the planned time it is serving to the
`claude_window_schedules` row, so a repeated check, a Server Core restart, or the background job
never sends twice for the same window. It then sends one minimal request and checks Claude Code's
usage reading a few times over the next half minute. A new future `resetsAt` confirms the window
(`trigger_confirmed`); a request that ended without moving the reading is `trigger_unverified` and
is not retried. A request that failed outright is `trigger_failed` and is not retried either,
because Caxri cannot tell whether it reached Claude; the chain picks up again at the next real
request's reset or the next morning anchor.

The request runs through the Claude Agent SDK with the same Claude executable and Agent environment
as a Claude Chat. It loads no settings, tools, MCP servers, or slash commands, runs the low-cost
model for one turn, and persists no session (`persistSession: false`), so it never appears in a
Caxri Session, Claude's resume list, or prompt history.

## Billing safety

The keeper sends only when every check passes; otherwise it shows the reason and sends nothing:

| Reason             | When                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authUnsupported`  | Claude Code is not signed in to claude.ai first party: an API key, auth token, base URL, or Bedrock, Vertex, or Foundry variable is set, or an API key helper or token is in use |
| `notSignedIn`      | Claude Code reports no account email and organization                                                                                                                            |
| `planUnsupported`  | The plan is neither Pro nor Max                                                                                                                                                  |
| `usageUnavailable` | Claude Code returned no 5-hour window reading                                                                                                                                    |
| `weeklyLimit`      | The weekly limit is used up                                                                                                                                                      |
| `claudeNotFound`   | The Claude CLI could not be found or started                                                                                                                                     |
| `probeFailed`      | Claude Code did not answer in time                                                                                                                                               |

A status read never sends a request. Checks between planned times read the account and usage only.

## Background job

Server Core runs the keeper while it is up. A packaged macOS build also registers a per-user
LaunchAgent (`com.caxri.app.claude-windows.<profile hash>`) that runs
`caxri host claude-window-tick --profile <userData> --json` at the anchor and each renewal time,
so windows keep rolling while Caxri is closed. Desktop rewrites the job when the schedule changes
and removes it when the keeper is turned off; `bun run uninstall:caxri` removes it too. A
development build never registers one and Settings says so. `host claude-window-tick` is a human
command: an Agent caller is refused.

## Accounts and persistence

`claude_window_schedules` holds one row per account: the SHA-256 of the account email and
organization, the user's switch and time, and the last processed planned time, observed reset,
and outcome. It never stores the email, organization, or credentials. The keeper serves the
single account Claude Code is signed in to; several Claude accounts are not supported yet.

## Diagnostics

The keeper logs `claude_window.checked` for every check (source, closed decision, status and
reason, planned time, lateness, duration) and `claude_window.outcome` for every decision that did
something, with a 16-character prefix of the account hash. Desktop logs
`claude_window.background_job` with the job outcome and the number of wake times. The event
catalog is `packages/protocol/src/domain/claude-window/log-events.ts`. No log carries the prompt,
model output, credentials, environment values, transcript paths, email, or organization.
