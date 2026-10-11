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
   ledger existed, or whose Terminals were still bound when it first ran, are covered.
2. **Scan.** For each row the provider transcript is located (Claude subagent side files included) and fingerprinted by
   size and mtime. Only changed transcripts are reparsed; the result is a content-free aggregate (hourly per-model
   token buckets, active time, created pull request URLs, the latest rate-limit windows) stored in `usage_json`. A
   pruned transcript keeps its last aggregate.
3. **Pricing.** Cost uses LiteLLM's public price list, the same source as `ccusage`: a cached copy refreshed daily,
   falling back to the snapshot bundled at build time (`scripts/update-model-prices.ts` regenerates it). Costs are API
   list-price estimates, not what a subscription plan charged. Models without a price are listed in the coverage note
   and count zero.
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
- **Codex** reports cumulative thread totals; usage is the delta between totals, and a shrinking total only resets the
  baseline. Cached input is inside `input_tokens`, so it is split out as cache reads. Reverting a thread (Esc Esc)
  continues it in a new `<thread>_<rollout>` file that opens with the whole thread's total; outside Caxri both files
  are read, and the continuation's first total only sets its baseline so the history is not counted twice.
- **Grok Build** reports exact per-prompt usage on `turn_completed`, deduplicated by prompt ID.

Active time sums gaps of at most five minutes between consecutive records of a main transcript; subagent files add
tokens but not time.

## Reuse for live readouts

The pipeline is split so a future per-Session status readout can reuse it without the report:

- `IncrementalUsageScan` (`apps/server/src/domains/usage/scanner.ts`) keeps per-file cursors and parser state, so
  calling `advance` again parses only appended records.
- `summarizeUsage` and `pricedUsageBuckets` (`apps/server/src/domains/usage/summary.ts`) total and price one aggregate,
  optionally from a start time.
- `formatUsd`, `formatTokens`, `formatDuration`, and `formatPercent` (`packages/protocol/src/domain/usage-format.ts`)
  keep every surface rendering the same number the same way.

## Privacy

Aggregates hold token counts, model names, timestamps, and pull request URLs only, never prompts, output, or file
contents; outside Caxri the stored working directory is the only path kept besides the transcript's own. Logs
(`usage.scan`, `usage.external_scan`, `usage.pricing`, `usage.pull_requests`) carry counts, durations, and closed
reasons.
