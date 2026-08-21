# Agent Actions

Caxri exposes skills and slash commands through one provider-neutral picker. `Command+Shift+A`
opens it for the active running Agent Terminal; Shell, stopped, and missing Terminals cannot open
the surface. The picker captures and displays its provider, Session, and Terminal target so a later
selection cannot drift to another Terminal.

## Interaction

- Search matches the exact invocation, its prefix-free name, and its description.
- `Enter` appends `<invocation>` to the existing Terminal draft without submitting it.
- `Command+Enter` appends `<invocation>\r` for an argument-free action. Required-argument actions
  must be inserted first and completed in the Terminal.
- Both paths perform one structured `terminal.input` write. Caxri never reads, clears, or replaces
  the current draft.
- Selection or `Escape` returns keyboard focus to the captured Terminal.
- `Manage in Settings…` opens the matching provider's Agent Actions editor. Users can hide shipped
  or discovered items and add an exact `/command` or `$skill` invocation with an optional label.

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
read; skill bodies and filesystem paths never cross IPC. Missing roots are normal, while unreadable
or unsafe entries produce a partial-result warning without hiding the actions that remain usable.

Caxri does not scrape an interactive CLI menu, execute a command to enumerate built-ins, or promise
that defaults match every installed version. When provider metadata is incomplete, the editable
settings list is the explicit compatibility fallback.

## Provider references

- [Codex CLI built-in slash commands](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands),
  including the provider-owned `/skills` browser
- [Codex Agent Skills](https://learn.chatgpt.com/docs/customization/overview#skills)
- [Claude Code interactive mode commands](https://docs.anthropic.com/en/docs/claude-code/interactive-mode)
