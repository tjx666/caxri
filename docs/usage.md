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

## What it shows

- Range totals (7 days to all time): estimated cost, tokens, active Agent time, Sessions created and archived, pull
  requests created and merged with their line counts.
- An activity heatmap over the trailing 53 weeks, with daily, weekly, and cumulative views, in tokens or cost.
- Highlights: streaks, busiest day and weekday, peak hour, cache savings, and the burn rate for today, 7 days, and 30
  days.
- Breakdowns by Agent, model, Project (linked worktrees roll up into their owning Project), and Session, plus the
  merged pull requests.
- The latest Codex rate-limit windows seen in a transcript.

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
3. **Pricing.** Cost uses LiteLLM's public price list, the same source as `ccusage`: a cached copy refreshed daily,
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

An Agent Terminal's status bar shows its bound conversation's running usage (`1.2M · $3.40 · 5h 62%`) and opens this
page on click. The Renderer polls `terminal.agentUsage` every two seconds; Server Core (`LiveAgentUsage`,
`apps/server/src/domains/usage/live-usage.ts`) keeps one `IncrementalUsageScan` per Terminal, so each poll parses only
records appended since the last one, and prices the result with the same rules as the report. The conversation's files
(Claude subagent side files, a reverted Codex thread's earlier rollouts) are relocated at most every 15 seconds; a
rebind to another conversation starts over. Nothing is written to the ledger: the report still counts the conversation
from its own scan.

## Reuse for live readouts

The pipeline is split so a per-conversation readout like the one above can reuse it without the report:

- `IncrementalUsageScan` (`apps/server/src/domains/usage/scanner.ts`) keeps per-file cursors and parser state, so
  calling `advance` again parses only appended records.
- `summarizeUsage` and `pricedUsageBuckets` (`apps/server/src/domains/usage/summary.ts`) total and price one aggregate,
  optionally from a start time.
- `formatUsd`, `formatTokens`, `formatDuration`, and `formatPercent` (`packages/protocol/src/domain/usage-format.ts`)
  keep every surface rendering the same number the same way.

## Privacy

Aggregates hold token counts, model names, timestamps, pull request URLs, and truncated SHA-256 digests of message or
prompt IDs only, never prompts, output, or file contents; outside Caxri the stored working directory is the only path kept besides the transcript's own. Logs
(`usage.scan`, `usage.external_scan`, `usage.pricing`, `usage.pull_requests`) carry counts, durations, and closed
reasons.
