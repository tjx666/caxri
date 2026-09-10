# Visible Agent delegation

Visible delegation runs a task in a managed Claude Terminal, in a sibling pane of the caller's
Session. Wide caller panes split right; narrow or tall panes split down. The existing active pane
and tab remain selected. The child uses the caller's working directory and remains available for
inspection after its answer is collected.

This is the first delivery stage of [issue #686](https://github.com/tjx666/caxri/issues/686).
It does not yet replace dianjiang: same-Terminal follow-up, explicit recovery/resume, Codex and
Grok delegation, presets, caller policies, usage accounting, and standalone directory authorization
remain subsequent stages of that umbrella issue.

## Commands and authority

The CLI accepts task text from a file, so the task body never appears in its process arguments:

```sh
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./task.md --request-id <stable-request-id> --json
caxri agent delegate status <delegation-id> --json
caxri agent delegate wait <delegation-id> --timeout 30000 --json
caxri agent delegate result <delegation-id> --json
```

Human mutations additionally require an explicit `--profile <path>` and confirmation (`--yes`
for unattended use). Managed Agents need an explicit, generation-scoped `agent:delegate` grant.
That grant provides `agents.delegate`, not dispatch, general Agent control, or human Terminal steer.
Server Core derives the caller Terminal from its authenticated Endpoint; a caller cannot supply a
different principal or Terminal. Agent access is restricted to its own Session and its own
delegations. The authenticated human owner can inspect tasks in the selected profile.

The request ID is scoped to the authenticated principal and generation. Reusing it with the same
input returns the existing task; different input conflicts. Wait timeout reports the current receipt
without interrupting, restarting, or resubmitting the task. A disconnected caller can later fetch
the saved answer using the same authorized identity.

## Correlation and persistence

Before any provider starts, Server Core saves the request, caller identity, native session ID,
frozen launch configuration, and task fingerprint in the private profile database. Task files use
`delegations/<delegation-id>/task.md`, private directories (0700), and exclusive files (0600).
The native interactive command receives only a fixed instruction pointing at that file.

Claude Code 2.1.196 or newer within major 2 is required. Its documented `prompt_id` binds the initial
`UserPromptSubmit` to a `Stop`. Only the bound launch enables prompt/answer SHA-256 evidence.
The hook bridge forwards identifiers, digests and closed failure classifications, never task or
answer bodies. See the [Claude hook reference](https://code.claude.com/docs/en/hooks).

Completion requires a coordinator-applied parent Stop, the exact launch/session/turn, and a matching
answer digest in the safely resolved native transcript. Attachment ancestry and text blocks sharing
one native message identity are followed. Child completion, an old turn, terminal silence and file
EOF cannot complete a delegation. Background collection retries bounded reads because native
transcript writes can lag Stop.

The first stage fails closed with `correlation_missing` if Claude introduces another prompt during
the task, including an unproven automatic continuation. It does not label an unproven continuation
as human input. Core-observed input in the child Terminal marks `human_intervened`; a retired launch
marks unfinished work `interrupted`.

Saved answers include the exact source record identity, source `transcript`, byte length and
truncation flag. An answer larger than 64 KiB is rejected as `payload_overflow`, never silently
shortened. Missing bounded transcript evidence becomes `result_missing`. `StopFailure` reports
rate-limit, billing/quota, authentication, output-limit or generic provider failure; its error text
is never returned as a task answer.

Server startup marks unfinished tasks `interrupted/host_reset` and never replays them automatically.
Completed answers survive restart. Deleting a Session removes its task metadata through the existing
metadata cascade; it never removes Project files. Private task files are not automatically removed.
Admission stops at 1,024 saved task records rather than evicting unclaimed answers.

## Current launch boundary

Launch settings are frozen per task. Supported configuration flags are the explicit model, effort,
permission mode, agent, name and tool-list values, plus verbose, disabled slash commands, strict MCP
configuration and the existing
configured permission-bypass flag. Caxri does not add permission bypass itself. Unknown flags,
positionals, print mode, resume/session overrides and remote/background modes fail before launch.
Startup trust/login interfaces receive no synthesized input. An unconfirmed startup remains
`awaiting_ready`, which callers can distinguish from a confirmed running turn.

Ordinary automated coverage uses isolated fake providers. Real-provider checks use only the guarded
debug procedure, a fixed synthetic task, and content-free evidence.
