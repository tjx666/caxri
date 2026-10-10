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
last response, the current turn, the whole Session, Codex's own time-to-first-token for the turn,
and a bar chart of the last `AGENT_THROUGHPUT_SAMPLE_LIMIT` (20) responses. There are no
thresholds or colours: what counts as slow is the reader's call.

A response whose start was never recorded (a resumed rollout, a compaction request, a Claude
message with no input after the previous one) is skipped rather than estimated. Until the first
measured response the chip is absent instead of holding a placeholder.

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
`apps/server/src/domains/agent-throughput.ts`). It resolves the Terminal's transcript through the
provider's locator (cached briefly so a 2 s poll does not rescan Codex's session index), then
scans only bytes appended since the previous read. Each transcript keeps running totals plus the
last 20 samples, so cost stays constant however long the Session gets; a rewritten or truncated
transcript resets its state. No transcript content is retained or logged, only token counts and
timestamps.
