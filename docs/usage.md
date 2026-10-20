---
kind: living
status: current
---

# Usage page

**Open Usage** (View menu, Command Palette, `usage.open`) opens a Workbench tab that answers what Agents cost,
what they produced, and when they worked. It covers the typical questions people answer with `ccusage` or CodexBar,
broken down by Agent (Claude Code, Codex, Grok Build). The scope toggle picks what counts:

- **Caxri** (default): only Agent Sessions started in a Caxri Session, archived and deleted Sessions included.
- **This Mac**: every Agent transcript on the machine, adding conversations run in a plain terminal or another app.

Clicking the status bar's Agent usage chip opens the page narrowed to the active Terminal's Session, over all time, so
the first screen is that Session's usage; the Session filter in the header clears it. The filter covers every
conversation the Session owns or currently hosts, so a conversation resumed there from another Session counts and the
page matches the chip. The report still attributes each conversation to the Session that first hosted it, so such a
resumed conversation appears under its owner's row in Most expensive Sessions, and unfiltered totals never count it
twice. A Terminal outside any Session, and **Open Usage** itself, show every Session.

The scope, Agent, and range filters are remembered on this device and restored the next time the page opens; a
Session-narrowed open still forces all time without overwriting the remembered range. Each row in Most expensive
Sessions has a filter button that narrows the page to that Session.

## What it shows

- Range totals (7 days to all time): estimated cost, tokens, active Agent time, Sessions created and archived, pull
  requests created and merged with their line counts.
- An activity heatmap over the trailing 53 weeks, with daily, weekly, and cumulative views, in tokens or cost.
- Highlights: streaks, busiest day and weekday, peak hour, cache savings, and the burn rate for today, 7 days, and 30
  days.
- Breakdowns by Agent, model, Project (linked worktrees roll up into their owning Project), and Session, plus the
  merged pull requests.
- The latest plan rate-limit windows: Codex's from its transcripts, Claude Code's from a running Chat (see
  [Plan limits](#plan-limits)).

In the **This Mac** scope, an Agent Session run outside Caxri belongs to the Project whose root contains its working
directory (rolled up to the owning Project like a linked worktree), or else to an "Outside Caxri" group. It has no
Caxri Session, so it appears in Most expensive Sessions titled by its folder, without a link, and the Agent time tile
counts it beside the Sessions ("+ N outside"). Created and archived Session counts stay Caxri-only.

Days and hours are the Client's local time zone; the Server buckets usage by hour and the report converts with the
zone the Client sends.

## Where the numbers come from

Server Core owns everything below; the page only renders `usage.report`.

1. **Ledger.** `agent_session_usage` gets a row the first time a Terminal binds a provider session ID
   (`TerminalsModel.updateAgentSessionId`), and every report reconciles current bindings first. A conversation resumed
   in another Session stays attributed to the Session that first hosted it. Rows outlive Session and Project deletion,
   so history survives cleanup; a deleted Session shows as "Deleted Session". Only Agent Sessions that ran while this
   ledger existed, or whose Terminals were still bound when it first ran, are covered. The ledger scan runs in the
   background like the outside-Caxri scan below: a report waits at most a second for it and reports the rows still
   unread in `coverage.pendingScans`, so the first open after an upgrade (which rescans every aggregate) answers at once.
2. **Scan.** For each row the provider transcript is located (Claude subagent side files included) and fingerprinted by
   size and mtime. Only changed transcripts are reparsed; the result is a content-free aggregate (hourly per-model
   token buckets, active time, created pull request URLs, the latest rate-limit windows) stored in `usage_json`. A
   pruned transcript keeps its last aggregate. A Claude conversation missing from the directory its working directory
   names is searched for across every Claude project directory once; a miss is remembered until that base directory
   changes or an hour passes, so a pruned transcript does not cost a full search on every report.
3. **Pricing.** Cost uses LiteLLM's public price list, the same source as `ccusage`: a cached copy refreshed daily from raw.githubusercontent.com (15 s timeout, 16 MiB cap; skipped under E2E),
   falling back to the snapshot bundled at build time (`scripts/update-model-prices.ts` regenerates it). Costs are API
   list-price estimates, not what a subscription plan charged. Models without a price are listed in the coverage note
   and count zero. Long-context tiers (LiteLLM's `*_above_<N>k_tokens` rates, for example Codex models above 272k and
   Grok above 200k) bill a whole request at the tier its input context exceeded, the vendors' rule and `ccusage`'s.
   Each bucket therefore records the context size class of its requests (`contextFloorK`, the largest of 100k, 128k,
   200k, 256k, 272k, 512k, or 1M the context exceeded), and the report applies the matching tier. Grok Build records
   its own cost estimate per turn (`costUsdTicks`, 10^10 ticks per USD); when present it replaces the list-price
   estimate.
4. **Outside Caxri** (This Mac scope only). Each report lists the providers' transcript directories
   (`~/.claude/projects/*/<id>.jsonl`, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` plus `archived_sessions`,
   `$GROK_HOME/sessions/<cwd>/<id>/updates.jsonl`), skips every Agent Session already in the ledger, and keeps one
   content-free aggregate per file in `external_agent_usage` by the same fingerprint rule. Files are read newest first
   in the background: a first scan of years of history takes about a minute, so the report waits at most a second,
   answers with what is cached, and reports how many transcripts remain; the page refreshes every two seconds until
   none do. The working directory comes from the Grok directory name or the first records of a Claude or Codex
   transcript.
5. **Pull requests.** URLs an Agent created are resolved through `gh pr view` in a bounded background pass (at most 40
   per pass, open ones rechecked every 30 minutes, merged and closed ones never). Until resolved they count as pending.

### Provider rules

- **Claude Code** repeats a message's growing `usage` on every streamed block. Records are merged per message ID by
  per-field maximum; summing them would multiply-count.
- **Codex** reports each request's own usage (`last_token_usage`) beside the thread's running total. An event whose
  total advanced counts its request, ccusage's rule: a forked thread's running total starts from its parent's, and a
  reverted thread's from the whole thread's, so a delta from zero would count that history again. Cached input is
  inside `input_tokens`, so it is split out as cache reads. Reverting a thread (Esc Esc) continues it in a new
  `<thread>_<rollout>` file; the ledger row points at the current rollout, so the ledger scan also reads the thread's
  earlier rollouts as one chain, keeping their turns in the hours they happened. Codex releases from June to August
  2026 also replayed the parent's events at the head of a forked subagent rollout, rewritten to one instant; a forked
  rollout that opens with two events within a second skips that burst. The processing tier comes from
  `thread_settings_applied`: requests at `priority` (Codex fast mode) or `flex` are priced at the multiple of the list
  price LiteLLM's `*_priority` and `*_flex` rates state.
- **Grok Build** reports exact per-prompt usage on `turn_completed`, deduplicated by prompt ID.

A billed unit (Claude `message.id` plus `requestId`, Grok prompt ID) can appear in more than one file:
`claude --resume <id> --fork-session` and a Grok resume or fork copy the earlier records, IDs and timestamps
unchanged, into a new file, and a forked Claude subagent's side file repeats its parent's last message. Each aggregate
keeps one-way digests of the units it counted (`keys`) and its file's creation time (`bornAt`); the earliest-created
file owns a shared unit, and later files skip it. When a copy happened to be scanned before its source, indexing the
source invalidates the copy, which the same sync rescans.

Active time sums gaps of at most five minutes between consecutive records of a main transcript; subagent files add
tokens but not time.

## Live conversation readout

An Agent Terminal's status bar shows its bound conversation's running usage (`1.2M · $3.40 · 7d 28% left`) and opens this
page on click. The Renderer polls `terminal.agentUsage` every two seconds; Server Core (`LiveAgentUsage`,
`apps/server/src/domains/usage/live-usage.ts`) keeps one `IncrementalUsageScan` per Terminal, so each poll parses only
records appended since the last one, and prices the result with the same rules as the report. The conversation's files
(Claude subagent side files, a reverted Codex thread's earlier rollouts) are relocated at most every 15 seconds; a
rebind to another conversation starts over. Nothing is written to the ledger: the report still counts the conversation
from its own scan.

A Claude subagent's task tab shows that subagent's own share the same way (`terminal.agentTaskUsage`): the scan keeps
each side file's usage apart as it folds it in, and `subagents/agent-<id>.meta.json` names the spawning tool call, which
is the Chat's task id. A unit the side file repeats from its parent stays with the parent, so the subagents never add
up to more than the conversation. These tokens replace the `total_tokens` Claude Code reports for the task, which is
only its latest request's context plus output. Codex and Grok Build keep no per-subagent transcript, so their task
tabs show the provider's count and no cost.

## Plan limits

The status bar lists the live plan windows shortest first, as what is left (`7d 28% left`), and turns `--warning`
once any window it shows has used 90%. The 5-hour window resets several times a day, so the chip leaves it out unless
`statusBar.usage.showFiveHourLimit` is on (`5h 62% · 7d 28% left`). Its hover card lists every window with its reset
either way. The figures are account-wide:
the newest reading Server Core has from any conversation.

- **Codex** writes its windows into the rollout, which the live scan already reads.
- **Claude Code** records no limits in its transcript, so Caxri reads them the way T3 Code does. While a Claude Chat
  is open and its provider process runs, `PlanLimitRefresh` (`apps/server/src/domains/usage/plan-limit-refresh.ts`)
  asks the Chat on each status-bar poll, and the Chat's `ClaudePlanLimits` (`claude-plan-limits.ts`) asks the process
  for its `/usage` answer through the Agent SDK's usage control request at most once a minute. In between, each
  `rate_limit_event` a turn streams replaces its window (the event's utilization is a 0 to 1 fraction, unlike the
  answer's percentage); an event before the first answer is dropped. The process uses its own credentials, so Caxri
  never reads the Keychain. A PTY Claude Terminal or a stopped Chat is never asked and never started for it, so its
  limits show only after a Claude Chat has run. An API-key account has no plan windows.

The phone reads the same figures through `mobile.agentChat.readUsage` (every paired role) and lists them in the model
sheet under Plan limits.

**Pace reminder.** When a multi-day window (the weekly limit) has less left than an even pace would leave, both
composers show a warning row above the input: `Weekly limit ahead of pace: 40% left, resets in 4d 2h`. An even pace
leaves `remaining time / window length` of the limit, so 5 of 7 days to go should leave about 71%. The row appears
only when what is left is at least `LIMIT_PACE_MARGIN_PERCENT` (5) points below that, so one long task early in the
week does not trigger it. Hiding it lasts for the rest of the local day. The rule is `limitPaceShortfall` in
`packages/protocol/src/domain/usage-format.ts`, shared by Desktop and the phone.

## Reuse for live readouts

The pipeline is split so a per-conversation readout like the one above can reuse it without the report:

- `IncrementalUsageScan` (`apps/server/src/domains/usage/scanner.ts`) keeps per-file cursors and parser state, so
  calling `advance` again parses only appended records.
- `summarizeUsage` and `pricedUsageBuckets` (`apps/server/src/domains/usage/summary.ts`) total and price one aggregate,
  optionally from a start time.
- `formatUsd`, `formatTokens`, `formatPercent`, and the limit-window helpers (`currentLimitWindows`,
  `remainingLimitPercent`, `limitPaceShortfall`) in `packages/protocol/src/domain/usage-format.ts` keep every
  surface rendering the same number the same way; Desktop localizes durations and limit windows in
  `apps/desktop/src/renderer/src/lib/usage-format.ts`.

## Privacy

Aggregates hold token counts, model names, timestamps, pull request URLs, and truncated SHA-256 digests of message or
prompt IDs only, never prompts, output, or file contents; outside Caxri the stored working directory is the only path kept besides the transcript's own. Logs
(`usage.scan`, `usage.external_scan`, `usage.pricing`, `usage.pull_requests`) carry counts, durations, and closed
reasons.
