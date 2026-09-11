# Visible Agent delegation

Visible delegation runs a task in a managed Claude Terminal, in a sibling pane of the caller's
Session. Wide caller panes split right; narrow or tall panes split down. The existing active pane
and tab remain selected. The child uses the caller's working directory and remains available for
inspection after its answer is collected.

This implements the Claude delegation and continuation stages of
[issue #686](https://github.com/tjx666/caxri/issues/686). It does not yet replace dianjiang:
Codex and Grok delegation, presets, caller policies, usage accounting, and standalone directory
authorization remain subsequent stages of that umbrella issue.

## Commands and authority

The CLI accepts task text from a file, so the task body never appears in its process arguments:

```sh
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./task.md --request-id <stable-request-id> --json
caxri agent delegate status <delegation-id> --json
caxri agent delegate wait <delegation-id> --timeout 30000 --json
caxri agent delegate result <delegation-id> --json
caxri agent delegate stop <delegation-id> --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --follow-up <delegation-id> --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --resume <delegation-id> --json
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

A background-child continuation belongs to the task only when the coordinator proves its exact
deferred parent turn and every subsequent prompt digest appears in order in the transcript ancestry.
An unproven new prompt fails closed with `correlation_missing`; it is not labeled human input.
Core-observed input in the child Terminal marks `human_intervened`; a retired launch marks unfinished
work `interrupted`. Terminal protocol responses do not count as human input.

Saved answers include the exact source record identity, source `transcript`, byte length and
truncation flag. An answer larger than 64 KiB is rejected as `payload_overflow`, never silently
shortened. Missing bounded transcript evidence becomes `result_missing`. `StopFailure` reports
rate-limit, billing/quota, authentication, output-limit or generic provider failure; its error text
is never returned as a task answer.

Server startup marks unfinished execution `interrupted/host_reset` and never replays it automatically.
Tasks already collecting a proven Stop can finish reading their exact saved evidence; completed
answers survive restart. Deleting a Session or Project drains pending task creation and removes its
private task files before the metadata cascade. Cleanup failure retains ownership records for retry.
Project folders and user files are never removed.
Admission stops at 1,024 saved task records rather than evicting unclaimed answers.

## Follow-up, stop, and recovery

`--follow-up` submits one fresh task in the existing Terminal and native conversation. It requires
the exact launch and a directly applied parent Stop with no later lifecycle activity or human input,
including an unsubmitted draft. Submission uses one bracketed paste and Enter. A bounded missing
submission confirmation fails without replaying the task. Each settled task admits only one child;
use the same request ID to recover a disconnected request.

`stop` interrupts only the owned active task and preserves its visible Terminal. Late completion
cannot replace the interrupted receipt. `--resume` explicitly starts a fresh task on the exact saved
native conversation with the original frozen settings, replacing only the proven owned generation.
It can also recover a stopped Terminal. It never resubmits the previous task: the caller must supply
new instructions that account for uncertain prior effects. Human takeover or another launch fences
both continuation operations. Each task retains its own answer and correlation evidence.

After Server restart, selecting a delegated Session restores the outer Shell only. Native Agent
resume requires the explicit operation above. The authenticated profile owner can recover saved
tasks; managed caller authority remains generation-scoped, so a newly launched caller does not
inherit the previous caller's delegation ownership.

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
