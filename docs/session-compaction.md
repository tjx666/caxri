---
kind: living
status: current
---

# Batch Session compaction

Run **Session: Compact Sessions with Warm Cache** from the Desktop command palette before leaving
long conversations idle. One invocation checks visible, unarchived Sessions and submits native
`/compact` to their eligible primary Claude Code or Codex Agent. It does not restart stopped Agents
or touch Grok Sessions.

The notification reports submitted requests and skipped or unconfirmed outcomes. Submission is not
proof of finished compaction; the native Agent window shows its progress. Results remain in notification
history. One failed Session does not prevent the remaining Sessions from being checked.

## Cache estimates

Server Core reads a bounded, provider-authorized native transcript tail. It uses the latest request's
input usage, not cumulative usage or transcript file size. No transcript content reaches notifications,
diagnostics, or application storage.

- Codex: `last_token_usage.input_tokens`, falling back to `total_tokens` when input is zero; 30 minutes.
- Claude: input, cache creation, and cache read tokens combined; explicit one-hour cache creation takes
  precedence over five-minute creation. A cache-read-only turn can reuse preceding lifetime evidence
  within the current compacted segment. Missing lifetime evidence falls back to one hour.
- A native compaction boundary retires preceding usage. A Session becomes eligible again only after a
  new request supplies usage and a new safely observed turn completes.

These defaults are estimates, not a promise of provider cache hits. Custom providers, older models,
routing changes, and changed prompt prefixes may differ. Requests at or beyond their estimated expiry,
future timestamps, and missing usage are skipped. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
Compaction itself may consume tokens and can change which prefix is reusable.

## Input and process ownership

The command writes to the existing managed Agent. Opening another process with `--resume` or a new
app-server is not an attachment to the live TUI. Codex's [`thread/compact/start`](https://developers.openai.com/codex/app-server)
requires the thread in that server; it does not compact an unrelated embedded TUI's in-memory context.

To protect drafts, Caxri requires an observed standalone Enter followed by an authenticated native
turn start and completion, with no additional input in between. This also excludes a draft typed while
the previous turn was running. Unknown, restored, queued, and permission-interrupted input states are
skipped rather than cleared. After restarting Caxri, complete a normal turn before batch compaction can
safely target that Session. Existing manual `/compact` remains available.

The Server rechecks primary Terminal, provider binding, Session visibility, launch generation, turn,
and idle proof after its asynchronous read and immediately before submission. It consumes input proof
before writing, so repeat clicks and ambiguous delivery never trigger automatic retries. Ordinary
human input remains available; the command does not take over the user's keyboard.

Each request checks at most 200 Sessions and reports any deferred count. Reads are sequential to bound
memory use. A delivered command proceeds in the provider independently of the batch notification.
