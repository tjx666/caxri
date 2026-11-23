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

Native rename, Agent messaging, and Agent Actions are unavailable. Messaging stays off as for Grok
Build, yet an `agy` Terminal can still start a delegation through the `caxri` CLI.

## Delegation

An `agy` Terminal can be a delegation target and caller. A target launches with the task pointer as
`-i <pointer>`, and `--model` and `--effort` select the model and thinking level. Initial arguments
are limited to `--model`, `--effort`, `--mode`, `--add-dir`, `--sandbox`, and
`--dangerously-skip-permissions`; it requires `agy` 1.4.11 or later within major 1.

- **Turn identity**: `agy` names no turn, so the bridge names one from `PreInvocation`'s
  `initialNumSteps` (`step-<n>`), the step count a turn starts after, which no earlier turn in the
  conversation shares. `Stop` carries a moved count, so Server Core gives a main-Agent `Stop` the
  turn its launch opened in the same conversation.
- **Correlation**: with delegation digests enabled, the bridge hashes `lastUserInput`, which equals
  the submitted pointer, as the turn's prompt digest; the text itself never leaves the bridge.
- **Completion**: the conversation database records no turn end, so the task enters `collecting`
  only after the matching `Stop`, and a Server restart before it interrupts the task. Collection
  reads the visible messages and takes the last reply after the pointer's latest occurrence.
- **Permissions**: the pointer file lives outside the Project. Without
  `--dangerously-skip-permissions`, `agy` may ask before reading it, and Caxri does not bridge that
  prompt to attention.

A one-time content-free probe of `agy` 1.4.12 confirmed these payloads: `PreInvocation` carries
`initialNumSteps` and `lastUserInput`, `Stop` carries `executionNum`, `terminationReason`, and
`fullyIdle` but no turn id, and the conversation database held the exact pointer and the reply.

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

The Bot handover's external conversation list does not include Antigravity yet.

## Bundled skills

Caxri installs its bundled skills to `~/.gemini/config/skills/<name>/SKILL.md` globally and to
`<project>/.agents/skills` locally, the same Project directory Codex reads. `agy` 1.4.11 reads both
roots; no environment variable relocates the global one. The installer makes `caxri-cli` a symlink
to a versioned release directory, as for the other Agents; a one-time `agy -p` probe of 1.4.11 listed
the skill from such a Project-local install.

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

Chat needs `agy` 1.5.0 or later, the release that added `agy acp`. A start fails as
`unsupported_version` ("update the CLI") when `initialize` reports an older `agentInfo.version`, or
when the handshake fails and `agy --version` names an older release, which has no ACP server to
answer it.

- `agy acp` picks the conversation id in `session/new`. The Chat binds it when its first turn
  starts, so a Chat that never ran a turn has no conversation to resume. Resume uses
  `session/load`, which replays the history without turn ends, so replayed turns read as completed.
- Caxri's Session instructions (see [Agent delegation](agent-delegation.md)) reach `agy` as
  `_meta.antigravity.systemPrompt.append` on both `session/new` and `session/load`, once
  `initialize` advertises `agentCapabilities._meta.antigravity.systemPrompt.append`. A real `agy`
  1.5.14 probe advertised it and followed the appended text.
- The model and thinking level are the `model` and `thought_level` config options, changed through
  `session/set_config_option`. `agy acp` also lists every model and level pair as a model; Caxri
  shows the config options instead.
- The global default is the `model` key of `~/.gemini/antigravity-cli/settings.json`, which `agy`'s
  own `/model` writes as a name from `agy models` with the level inside it
  (`Gemini 3.8 Flash (High)`; a model listed once, such as `Claude Sonnet 4.6 (Thinking)`, has no
  level). Settings › Agents › Default model reads and writes that key against the models a Chat
  listed last, and checks the name against `agy models` before saving. `agy acp` ignores the key
  (agy 1.5.14), so a Chat applies the default itself once it starts, then its own choice on top;
  see `model-choice/antigravity-defaults.ts`.
- Tool calls carry Antigravity's own tool name (`view_file`, `run_command`, ...) and PascalCase
  input; `providers/antigravity/items.ts` maps them to the names every Chat surface uses. A rejected
  command goes back to `in_progress`, so only the Chat's record of the user's answer marks it
  declined.
- Context usage is the latest `usage_update` (`used` of `size` tokens), applied as it arrives and
  after a `session/load` replay; without one it falls back to the prompt result's
  `usage.totalTokens`. The cache notice assumes the Gemini API's default 60-minute cache lifetime,
  an estimate.
- The permission level and plan mode are session modes (`default`, `accept-edits`, `auto`,
  `plan`), switched in place; full access is a launch flag and restarts. See
  [Permission level and plan mode](agent-chat.md#permission-level-and-plan-mode). In plan mode the plan arrives as a
  `write_file` artifact with `ArtifactMetadata.RequestFeedback`, which the Chat shows as a proposed
  plan with Start Building.
- Images are ACP `image` content blocks; the user message keeps only the Client's thumbnails.
- A message sent while a turn runs is a second `session/prompt`: `agy acp` ends the running request
  with `end_turn` and carries on with the new message in the same turn, so the Chat ignores the
  superseded answer and shows the message as steered.
- `agy acp` answers `session/prompt` with `end_turn` once it moves a slow foreground command to the
  background, then reports the command finished later (agy 1.5.14: a 25 s `sleep` ended the prompt
  at about 16 s and finished 8 s after it). The Chat keeps such a turn running until every
  foreground command (`run_command` without `IsDaemon`) that is running has finished; a declined
  command, which agy leaves `in_progress`, and a daemon do not hold it. Stop ends a held turn as
  interrupted. See `providers/acp/running-tools.ts`.
- A prompt that fails with Antigravity's used-up quota (`You have exhausted your quota on this
model.`, or `RESOURCE_EXHAUSTED`) fails the turn with a usage-limit notice naming the window and
  reset from a fresh `/usage` reading (see [Plan limits](#plan-limits)), which Continue in another
  Agent and auto-continue use.
- Edit from here and Fork from here copy the conversation, since `agy acp` cannot truncate or copy
  one: `copyAntigravityConversation` snapshots `conversations/<id>.db` with `VACUUM INTO`, cuts the
  copy just before the message, and gives it a new id. An edit then switches the Chat to the copy,
  so the original conversation stays whole in agy's own history. The copy drops every
  `gen_metadata` and `executor_metadata` row: they hold per-call usage and executor state, not
  history, and kept rows would count the original's usage twice. A real `agy` 1.5.14 probe
  resumed such a copy with exactly the kept turns and none of the cut ones. Before cutting, the
  record's newest user steps must match the Chat's user messages from the edited one on, steered
  ones included, or the action is refused and nothing changes. File restore stays unavailable:
  agy keeps no file checkpoints.

## Plan limits

`agy -p /usage --output-format json` runs the built-in `/usage` command without a model turn
(`num_turns: 0`, zero tokens), so reading it spends no quota. Its answer groups models that share
a quota (`Gemini Models`, `Claude and GPT models`), each with `5h`, `weekly`, or `monthly`
buckets and the fraction left. `providers/antigravity/usage-command.ts` maps each enabled bucket to
a usage-limit window with its `group` (`Gemini`, `Claude & GPT`); the status bar names the group
and shows only the groups the conversation's models belong to, and `usageLimitedUntil` treats the
account as limited only while every group is used up.

A running Chat reads it at most once a minute when the status bar asks (`AntigravityPlanLimits`),
and afresh after a turn fails on the quota. The same command answers the sign-in marker: a signed-out
CLI prints `status: ERROR` with `authentication failed or timed out` and exits, rather than waiting
for a pasted code, because the command runs with stdin closed. A signed-out Antigravity row in the
new-Agent menus offers "Sign in…", which types `agy` into a new Shell Terminal: `agy` has no sign-in
subcommand, and started interactively while signed out it runs its own browser sign-in.

## Verification boundaries

Automated tests use repository-owned fakes
(`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-antigravity-acp.ts`) and isolated
homes; they never invoke the host `agy`. The ACP shapes, hook payloads, and state layout were
checked once with a content-free local probe of `agy` 1.4.11, and the session modes, image
prompts, steering, `usage_update`, plan artifact, and `/usage` answer with `agy` 1.5.14.
