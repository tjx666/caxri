---
kind: living
status: current
---

# Agent Commands & Skills

Caxri exposes skills and slash commands through one provider-neutral picker. `Command+Shift+A`
opens it for the active running Agent Terminal; Shell, stopped, and missing Terminals cannot open
the surface. The picker captures and displays its provider, Session, and Terminal target so a later
selection cannot drift to another Terminal.

An Agent Chat reuses the same discovery and search for the skills its composer offers after `/` or
`$`; see [Agent Chat](agent-chat.md#images-and-slash-commands).

## Interaction

- Search matches the exact invocation, its prefix-free name, and its description. Exact, prefix,
  word-initial, and fuzzy name matches rank ahead of description-only matches; `/` and `$` remain
  optional unless the user wants to restrict results to actions using that prefix.
- `Enter` and mouse selection run an argument-free action immediately. Commands and Claude Code
  skills append Return in one write. Codex skills append the invocation, wait 150ms for its paste
  detector to settle, then append Tab and Return so the composer accepts the exact skill completion
  before submitting it. Required-argument actions remain open with a prompt to insert and complete
  them first.
- `Command+Enter` appends `<invocation>` without submitting it, then returns focus to the Terminal
  so the user can add arguments.
- Insert and ordinary run paths perform one structured `terminal.input` write; a Codex skill run
  performs the two ordered writes above. Caxri never reads, clears, or replaces the current draft.
- Selection or `Escape` returns keyboard focus to the captured Terminal.
- A search starting with `@` lists other Sessions by title instead of actions. Choosing one appends
  a reference to a condensed copy of that Session's conversation without Return; see
  [Citing another Session](session-conversation-context.md#citing-another-session-with-). The
  Terminal's own `@` list belongs to the Agent CLI, so this picker is where a Terminal cites one.
- `Manage in Settings…` opens the matching provider's Agent Commands & Skills editor. Users can
  hide shipped or discovered items and add an exact `/command` or `$skill` invocation with an
  optional label.

## Sources and precedence

Caxri merges three sources in deterministic order:

1. A small built-in fallback of common non-destructive commands.
2. Provider-owned filesystem discovery.
3. User settings, which may override metadata, disable an item, or define a custom item.

The built-in fallback deliberately does not attempt to mirror every CLI release. Codex currently
ships `/model`, `/compact`, `/diff`, `/review`, and `/status`; Claude Code ships `/model`,
`/compact`, `/diff`, `/review`, and `/context`. Provider discovery adds current skills and Claude
Code custom commands while retaining Codex's earlier skill roots. Within each cell below, roots are
listed from lower to higher precedence:

| Provider    | User roots                                                 | Project roots from Project to cwd    |
| ----------- | ---------------------------------------------------------- | ------------------------------------ |
| Codex       | `$CODEX_HOME/skills`, `~/.agents/skills`                   | `.codex/skills`, `.agents/skills`    |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills`, `$CLAUDE_CONFIG_DIR/commands` | `.claude/skills`, `.claude/commands` |

Codex skills keep their `$name` invocation because the picker sends text to the Agent's real PTY;
slash commands remain `/name`. Claude Code skills and commands both use `/name`, with nested custom
commands represented as `/directory:name`.

The table lists the filesystem scan, which is the whole answer for the Terminal picker. For a Codex
Chat whose app-server process is already running, `agentActions.list` and `agentActions.read` also ask
it for the `{"method":"skills/list"}` request (`forceReload`, the Chat's cwd) and let that list win for skills: enabled plugin
skills appear, a skill Codex has turned off disappears, and a scanned skill Codex does not list is
dropped. Commands stay from the scan, and each reported `SKILL.md` path stays on the Server. A
Chat without a running process, or a failed or unsupported `{"method":"skills/list"}` request, falls back to the scan
alone; listing never starts a provider.

The persisted settings shape is provider-local:

```jsonc
{
  "agents.providers": {
    "codex": {
      "actions": {
        "items": {
          "/goal": { "enabled": true, "description": "Manage a long-running goal" },
          "$commit": { "enabled": false },
        },
      },
    },
  },
}
```

## Discovery boundary

Runtime derives roots from the selected Terminal's durable provider, cwd, and authorized Project;
Renderer cannot submit an arbitrary path. Traversal is breadth-first and bounded by depth, entry,
file-size, and result limits. Canonical paths must remain inside the declared root, so symlink escape
is rejected. Only scalar `name`, `description`, `argument-hint`, and `user-invocable` frontmatter is
read for listing, and filesystem paths never cross IPC. `agentActions.read` returns one discovered
action's body (frontmatter stripped, capped at 64 KiB) by invocation, so an Agent Chat can show the
skill a message invoked; it re-runs discovery for that Terminal, accepts no path, and works while the
Agent is stopped. Missing roots are normal, while unreadable
or unsafe entries produce a partial-result warning without hiding the actions that remain usable.

Caxri does not scrape an interactive CLI menu, execute a command to enumerate built-ins, or promise
that defaults match every installed version. When provider metadata is incomplete, the editable
settings list is the explicit compatibility fallback.

## Provider references

- [Codex CLI built-in slash commands](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands),
  including the provider-owned `/skills` browser
- [Codex Agent Skills](https://learn.chatgpt.com/docs/customization/overview#skills)
- [Claude Code interactive mode commands](https://docs.anthropic.com/en/docs/claude-code/interactive-mode)
