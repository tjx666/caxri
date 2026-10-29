---
kind: living
status: current
---

# Agent secrets

Agents often need an API key, a token, or a password to run a command: a deploy, an eval against a
model API, a database migration. Without help they ask the user to paste it into the conversation,
where it stays in the transcript, the provider's history, and every later context window. Caxri
keeps those values out of the conversation: the user saves each secret once, and an Agent runs the
command that needs it through `caxri secret exec`, which hands the value to that command only.

## What the user sees

- **Settings → Agents → Secrets** lists every saved secret by name and scope. Values are write-only:
  a secret can be added, replaced, or deleted, never shown again.
- **A request card** appears in the bottom-right corner of every Workbench window when an Agent runs
  `caxri secret request`. It names the Agent, its Session and Project, the secret, and the Agent's
  reason (labelled as the Agent's own words). The value field is masked and ignored by password
  managers. The card never takes focus by itself, so a request that arrives while the user types
  cannot capture keystrokes. Save stores the value for the request's Project, or for every Project
  when **Use in all Projects** is ticked; Decline tells the Agent no. One card shows at a time,
  oldest first.

## What the Agent runs

```bash
caxri secret list --json
caxri secret request OPENAI_API_KEY --reason "Run the eval script" --json
caxri secret exec OPENAI_API_KEY -- bun run scripts/eval.ts
```

- `secret list` returns names and scopes, never values.
- `secret request` returns at once when the secret already exists. Otherwise it raises a card and
  long-polls until the user answers. It waits at most 100 seconds per run, below Claude Code's
  two-minute default Bash timeout, then exits `TIMEOUT` saying the request is still open; running
  the same command again joins that request instead of raising another card. A decline exits
  `CANCELLED`.
- `secret exec NAME... -- <command>` resolves the named secrets, adds them to the environment of the
  child command (started from an argv array, never a shell string), and exits with the child's own
  status. Everything after `--` belongs to the child, so its `--json` or `--help` is never read as a
  Caxri option. A missing secret fails with `NOT_FOUND` and names the `secret request` command to
  run.

The bundled `caxri-cli` skill tells Agents to use these commands instead of asking in chat. Caxri
does not inject secrets into an Agent's launch environment: an injected `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` would silently switch the Agent CLI's own sign-in and billing.

## Scopes

| Scope   | Reaches                                                      |
| ------- | ------------------------------------------------------------ |
| Project | Agents in that Project and in every worktree Project it owns |
| Global  | Agents in every Project                                      |

A Project secret overrides a global one with the same name, as in Synara and Mux. Names are environment variable names;
`CAXRI_` names and the shell's own (`PATH`, `HOME`, `SHELL`, and similar) are refused, so a secret
can never replace the launch environment `secret exec` passes on. Deleting a Project drops its
secrets; global ones stay.

## Authority

Every managed Agent Endpoint holds the baseline `secrets.use` capability. Server Core binds each
`agent.secret.*` request to the Project and Terminal of the caller's authenticated Endpoint, so an
Agent never names the Project whose secrets it reads, and only the Terminal that raised a request
can wait on it. Settings management (`secrets.*`) is Desktop-only. External delegation callers and
the human CLI have no secret commands.

`secret exec` keeps the value out of the conversation, not out of the child command: a child that
prints its environment puts the value in the Terminal output the Agent reads. The skill tells
Agents not to do that; Caxri does not redact output.

## Storage

Secrets live in `agent-secrets.json` in the profile's user-data folder, an owner-only (`0600`) file
outside `settings.jsonc`, the database, logs, and diagnostic exports. Values are plain text on
purpose: Caxri's security bar is a single user on their own machine, an encrypted file would keep its
key beside it, and the macOS Keychain shows a password prompt whenever the login keychain is locked,
which would stall an Agent's command. A damaged file fails every secret operation instead of being
replaced.

Requests live only in Server Core's memory. A request expires after 15 minutes unanswered, and is
withdrawn when no `secret request` has polled it for 90 seconds (the Agent was interrupted, gave up,
or exited). A Server Core restart withdraws every card.

## Diagnostics

The `agent_secrets.*` log events record outcomes and counts only: `saved` (scope kind and source),
`requested` (`available`, `raised`, or `joined`), `request_settled` (status and duration), `resolved`
(requested and found counts), and `project_pruned` (removed count). No event carries a secret's
name or value.
