---
id_prefix: ux
verify: true
skip_when: no user-visible component, style, copy, shortcut, dialog, editor, terminal, or interaction changed
---

# UX and Accessibility

Review observable states against Caxri's workbench behavior and `DESIGN.md`, not generic taste.

## Quick checklist

- Terminal loses visual priority, multiple accents compete, or chrome uses saturated state color
  where semantic foreground/background tokens should carry the design
- Literal/default-palette color utilities bypass runtime theme tokens; imported themes or contrast
  break
- Decorative motion, gradients, or emoji standing in for real icons carry no state meaning and pull
  attention from the Terminal, typical agent-generated styling filler
- Continuous or looping animation ignores `prefers-reduced-motion`
- UI exposes implementation terms such as Runtime, hot reload, snapshot bytes, or internal error
  codes instead of a user action and outcome
- Focus, hover, disabled, loading, empty, success, error, exited, reconnecting, or recovery state is
  missing or contradictory
- Global shortcuts fire inside editable targets or modal dialogs, ignore IME/repeat behavior, or do
  not render from live keybindings where the UI shows a hint
- Interactive controls are not keyboard reachable; color-only status lacks text/ARIA; focus is lost
  after dialogs, menus, tab moves, or Session switches
- Deleting a Project/Session lacks a native confirmation naming the target and stating that files on
  disk are untouched
- External disk changes introduce a conflict prompt or preserve a dirty buffer contrary to the
  explicit replace-with-notice product rule
- Terminal exit/restart, tab preview/pinning, Git diff tabs, split panes, or Session-scoped state
  diverges from the nearest established interaction without a recorded product decision
- Large lists/diffs/search results become unusable without pagination, lazy loading,
  virtualization, or bounded results
- An approval surface displays one value while approving, submitting, or executing a separately
  normalized or mutable value without proving they share the same canonical identity

## How to check

1. Enumerate every visible state introduced or changed.
2. Walk mouse, keyboard, and failure paths in the smallest relevant Electron workflow.
3. Inspect computed behavior/theme tokens, not only class names.
4. Compare with the nearest existing Caxri interaction and recorded acceptance criteria.
5. For approvals, trace the displayed, approved, submitted, and executed value from one canonical
   representation. Include edits, normalization, stale dialogs, retries, and target replacement
   between display and execution.

## Rule sources

- `DESIGN.md`
- `.agents/skills/project-architecture/references/product-model.md`
- `.agents/skills/project-architecture/references/editor-and-search.md`
- `.agents/skills/project-architecture/references/settings-and-themes.md`
- Existing focused Playwright workflows in `e2e/`

## Not violations

- Taste differences within the semantic-token and spacing system
- Missing decorative polish that does not hide state or block interaction
- States unreachable through the real UI and typed contract
