---
kind: living
status: current
---

# Agent output speed

An Agent Terminal shows how fast its Agent is generating, as output tokens per second
(`62 tok/s`), at the right of the status bar. The number is read from the Agent's own transcript,
so it needs no provider API, telemetry export, or proxy, and it sends nothing anywhere.

## What the number means

Each sample is one model response: its `output_tokens` (reasoning included for Codex) divided by
the request's wall-clock time. The request starts at the last input before the response produced
anything and ends at the response's last generated item, so the time **includes** queueing and the
wait for the first token and **excludes** tool execution between responses. Aggregates are
token-weighted (`Σ tokens / Σ time`), never an average of per-response rates, so a burst of tiny
responses cannot dominate.

The chip shows the last `AGENT_THROUGHPUT_RECENT_RESPONSES` (10) responses. The hover card adds the
last response, the current turn, the whole Agent Session, Codex's own time-to-first-token for the
turn, and a bar chart of the last `AGENT_THROUGHPUT_SAMPLE_LIMIT` (20) responses. While the turn
covers exactly the same responses as the Agent Session (its first turn), the card drops the turn row
and shows only the Agent Session row, since two identical rows would read as two different facts.
There are no thresholds or colours on the number: what counts as slow is the reader's call. The
only colour the chip carries is the provider's status dot (see [Provider API status](#provider-api-status)).

Clicking the chip, or running `Show Agent Status` (`terminal.showAgentStatus`, available only while
the active tab is an Agent Terminal), opens an Agent status tab (`caxri-agent-status://<terminalId>`)
for that Terminal: the same figures as tiles, led by a `Recent average` tile carrying the chip's own
number and its `Average of the last N responses` caption, a larger per-response chart with the
recent average drawn as a dashed line, a `By model` table, and the provider's API status below.

The `By model` table splits the Agent Session's responses by model and speed mode (`Standard`,
`Fast`, `Flex`), so a Fast-mode turn and a model switch read as separate rows instead of moving one
average. Claude Code records both on every message (`message.model`, `usage.speed`). Codex names the
model on each `turn_context` but writes the thread's `service_tier` (`priority` or `fast` is Fast
mode) only in a `thread_settings_applied` event when the setting changes, so responses before the
first change show `Mode not recorded` rather than a guessed tier. The Server keeps at most 32
model/mode rows per transcript.

Without a measured response the tab names which of three cases it is in, so they never collapse into
one "nothing measured" sentence (`agent-throughput-state.ts`): a failed transcript read says so in
`--danger` with a Retry button; a Terminal that closed before its first measured response says
nothing was measured before it closed; and a live Agent that has not finished a response yet says
speed appears after its first one. A reading already on screen outranks a later failed poll.

A response whose start was never recorded (a resumed rollout, a compaction request, a Claude
message with no input after the previous one) is skipped rather than estimated. Until the first
measured response the chip is absent instead of holding a placeholder, unless the provider's status
page reports a problem: then it shows a muted dash placeholder with the status dot, so an incident is
visible before the first prompt.

## Providers

The provider descriptor's optional `createThroughputScanner` owns the transcript rules
(`apps/server/src/domains/agents/providers/*/throughput.ts`). A provider without one shows no chip.

- **Codex** writes one `token_usage_record` per response, keyed by `response_id`. Inputs are
  `task_started`, user/developer messages, tool outputs, and `agent_message`; outputs are reasoning,
  tool calls, and assistant messages. The usage record is not the end time, because a streamed tool
  may already be running when it is written. Tool results that arrive after the response began
  generating (parallel calls) do not restart the clock.
- **Claude Code** repeats the final usage on every line of a message, so a response is the run of
  lines sharing `message.id`, ending at its last line. Tool results written between lines of the
  same message (streamed tool execution) do not split it. Sidechain, API-error, and `<synthetic>`
  lines are ignored; a real prompt starts a new turn.

## Server path

`terminal.agentThroughput` is a polled read (`AgentThroughputService`,
`apps/server/src/domains/agents/agent-throughput.ts`). It resolves the Terminal's transcript through the
provider's locator (cached briefly so a 2 s poll does not rescan Codex's session index), then
scans only bytes appended since the previous read. Each transcript keeps running totals plus the
last 20 samples, so cost stays constant however long the Agent Session gets; a rewritten or truncated
transcript resets its state. No transcript content is retained or logged, only token counts and
timestamps.

## Provider API status

The hover card and the status tab also show the provider's public service status, so a slow Agent
can be told apart from a provider incident. Only the components an Agent depends on are read:
Claude's `Claude API` and `Claude Code` components from its Statuspage summary, and OpenAI's
`Codex API` component from its incident.io page. For incident.io, Main also reads the page's
90-day component history (`component_impacts`) and the status tab draws it the way
status.openai.com does: the page's own uptime percentage and one bar per local day, colored by the
worst impact that day, with a tooltip naming the day and status. A failed history read leaves the
current status in place and drops only the bars. Grok has no public status page, so its status row is
omitted. Unresolved incidents touching those components are listed with their phase and latest
update; incidents on other components (such as claude.ai) are left out.

While the reading says something is wrong, the chip itself shows it without a hover: maintenance or
degraded performance draws a `--warning` dot on the gauge glyph's corner, and a partial or major
outage a `--danger` one, the same status-to-tone mapping the status tab's dots use. The chip's
accessible name ends with the status in words (`API status: Partial outage`). An operational
provider, a first read still pending, a provider without a status page, and a page Caxri could not
read raise no dot, because none of them is evidence of an incident (`providerStatusAlert` in
`apps/desktop/src/renderer/src/features/agent-status/agent-provider-status-label.ts`).

`agentProviderStatus.read` is a Desktop Main method over the shared reader in
`packages/system/src/network/agent-provider-status.ts`. Main fetches through Electron's `net.fetch`
because it honors the system proxy, which Server Core's Node `fetch` does not, and the Renderer's
CSP forbids the request. Results are cached per provider (60 s after success, 30 s after failure)
and concurrent reads share one request. A failure is reported to the UI with a closed reason
(`network`, `http`, `invalidResponse`) plus a link to the page; the log records
`external_status.provider_status_failed` once per reason change and
`external_status.provider_status_recovered` when the page reads again. The Codex uptime history is
read beside the current state and fails on its own: the page still answers without the strip, and
the log records `external_status.provider_history_failed` and
`external_status.provider_history_recovered` the same way. Under `CAXRI_E2E=1` Main
never touches the network: it reads fixtures from `CAXRI_E2E_PROVIDER_STATUS_DIR`, preferring
`<hostname>.<last path segment>.json` (such as `status.openai.com.component_impacts.json`) and
falling back to `<hostname>.json`, and reports `network` without one.
