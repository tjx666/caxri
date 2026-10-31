---
kind: living
status: current
---

# Antigravity

Caxri hosts Google's Antigravity CLI (`agy`) as a managed Agent Terminal, or runs it as an Agent
Chat over its `agy acp` subcommand (see [Chat](#chat)). Both use the installed CLI and its existing
authentication; Caxri does not install `agy` or call a Gemini API. The verified baseline is `agy`
1.4.11 on macOS arm64.

## Terminal launch

The default argument is `--dangerously-skip-permissions`. Caxri owns conversation identity and the
interactive terminal, so Initial arguments that pick a conversation or leave the TUI (`--`,
`--conversation`, `--continue`/`-c`, `--print`/`-p`, `--prompt`, `--prompt-interactive`/`-i`,
`--output-format`, `--input-format`) are rejected before spawning. An initial prompt is passed as
`-i <prompt>`, which keeps the TUI open.

Unlike Claude Code and Grok Build, `agy` accepts no client-chosen conversation id: a new Terminal
starts unbound and learns its id from the lifecycle hooks below. Restore runs
`--conversation <id>` with the exact bound id and first checks that
`~/.gemini/antigravity-cli/conversations/<id>.db` exists; a missing conversation fails with
`agent_session_unavailable` instead of silently opening a new one. An unbound Terminal (no turn ever
ran) restarts as a fresh conversation, since there is nothing to resume. Automatic background
suspension is disabled for this provider.

## Identity and activity

Lifecycle hooks are required for managed Terminal launches, as for Grok Build; a Chat does not use
them. Caxri owns one named hook, `caxri`, in `~/.gemini/config/hooks.json`, whose top-level keys
name independent hooks, so another tool's hooks are never touched. `agy` splits a hook command into
argv instead of running it through a shell, so the handler is `/bin/sh -c '<bridge command>'`, and
every handler must print a JSON object, so the bridge replies `{}`. The bridge forwards bounded
identifiers and event metadata, never prompts, responses, transcripts, or Terminal output: it only
checks that `lastUserInput` is present.

| Event           | Phase                          | Condition                                    |
| --------------- | ------------------------------ | -------------------------------------------- |
| `PreInvocation` | `turnStarted`                  | Only a turn's first call (`invocationNum` 0) |
| `Stop`          | `turnFinished` or `turnFailed` | Skipped while `fullyIdle` is `false`         |

`PreInvocation` runs before every model call, so only the first one starts a turn. A `Stop` whose
`terminationReason` is an error, an invocation or token limit, a user cancel, or a hook termination
marks the turn failed. Both events carry the `conversationId`, which binds the Terminal.
`SessionStart` is deliberately not bound: a subagent's conversation fires it too, with nothing that
tells it apart from the main one, and any identity signal rebinds the Terminal.

Native rename, Agent messaging, Agent Actions, and Agent delegation are unavailable; delegation
and messaging are tracked in [issue #3272](https://github.com/tjx666/caxri/issues/3272).

## Conversation database

Session search and Usage read `~/.gemini/antigravity-cli/conversations/<id>.db` directly, opened
read-only (`providers/antigravity/conversation-database.ts`). Each conversation is a SQLite database
in WAL mode whose `steps` and `gen_metadata` rows hold protobuf blobs; the field numbers come from the
descriptors embedded in `agy` 1.4.11 and were checked against real databases with a content-free
structural probe. A layout change degrades to missing values, never a throw.

- **Messages**: only `USER_INPUT` and `PLANNER_RESPONSE` steps are decoded, taking the user's query
  and the reply's visible response. Thinking, tool calls, tool output, and system steps are never
  selected. A conversation whose `trajectory_meta.source` is `SUBAGENT` is excluded, like other
  Agents' sidechains.
- **Folder and title**: from `conversation_summaries.db` (`workspace_uris` and `title`); the raw
  first prompt in `preview` is never read.
- **Usage**: one `gen_metadata` row is one billed model call, keyed by conversation id and row index.
  `input` excludes cache reads, which are counted separately, and `output` already includes thinking
  tokens. A running `agy` appends to the write-ahead log, so the change stamp covers the database and
  its `-wal` file, and each refresh re-reads the whole conversation. Cost uses the Gemini API list price of
  the model family (`gemini-3.8-flash-n` prices as `gemini-3.8-flash`), which the bundled price
  snapshot includes for offline use.

The Bot handover's external conversation list does not include Antigravity yet, because it only
lists delegation targets.

## Bundled skills

Caxri installs its bundled skills to `~/.gemini/config/skills/<name>/SKILL.md` globally and to
`<project>/.agents/skills` locally, the same Project directory Codex reads. `agy` 1.4.11 reads both
roots; no environment variable relocates the global one.

## Conversation title

The metadata probe reads the bound conversation's `title` from
`~/.gemini/antigravity-cli/conversation_summaries.db`, opened read-only. `agy` generates that title
itself; the same row's `preview` holds the raw first prompt and is never read. An unbound Terminal
reads no title, and a missing or invalid value leaves the current title untouched.

## Chat

A Chat runs `agy acp` and speaks ACP v1 through the shared ACP client; [Agent Chat](agent-chat.md#acp-mapping)
owns the provider-neutral mapping. Initial arguments are filtered rather than appended: `--sandbox`
and `--add-dir` pass through, `--dangerously-skip-permissions` selects full access, and everything
else is dropped because `agy acp` has no model flag.

- `agy acp` picks the conversation id in `session/new`. The Chat binds it when its first turn
  starts, so a Chat that never ran a turn has no conversation to resume. Resume uses
  `session/load`, which replays the history without turn ends, so replayed turns read as completed.
- The model and thinking level are the `model` and `thought_level` config options, changed through
  `session/set_config_option`. `agy acp` also lists every model and level pair as a model; Caxri
  shows the config options instead.
- Tool calls carry Antigravity's own tool name (`view_file`, `run_command`, ...) and PascalCase
  input; `providers/antigravity/items.ts` maps them to the names every Chat surface uses. A rejected
  command goes back to `in_progress`, so only the Chat's record of the user's answer marks it
  declined.
- Usage is the prompt result's `usage.totalTokens`; `agy acp` reports no context window. The cache
  notice assumes the Gemini API's default 60-minute cache lifetime, an estimate.
- Images, steering a running turn, rewind, fork, and file restore are unavailable: `agy acp`
  advertises no prompt capabilities and offers no way to truncate or copy a conversation. Edit is
  hidden and Fork Session is disabled with its reason; Continue in another Agent still works.
  A message sent while a turn runs waits in the queue and starts the next turn.

## Verification boundaries

Automated tests use repository-owned fakes
(`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-antigravity-acp.ts`) and isolated
homes; they never invoke the host `agy`. The ACP shapes, hook payloads, and state layout were
checked once with a content-free local probe of `agy` 1.4.11.
