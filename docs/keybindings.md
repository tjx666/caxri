---
kind: living
status: current
---

# Keybindings

Caxri resolves keyboard shortcuts in the Renderer, from a single user-editable table
(`keybindings.jsonc`). This document covers the parts that are not obvious from the table: the
binding format, how a two-chord sequence such as `Cmd+K Cmd+S` is dispatched, and why the embedded
Monaco editor is allowed to take some sequences away from the application.

## Binding format

A keybinding's `key` is one or more **chords** separated by whitespace. A chord is one key
combination: modifiers joined with `+`, then the main key.

```jsonc
[
  { "key": "cmd+shift+k", "command": "terminal.clear" },
  { "key": "cmd+k cmd+s", "command": "settings.openKeybindings" },
  { "key": "cmd+k v", "command": "editor.openPreviewToSide" },
]
```

Normalization (`packages/protocol/src/configuration/shortcuts.ts`) lowercases the input, rewrites
`command` to `cmd`, orders modifiers `cmd ctrl alt shift`, and collapses whitespace around `+`, so
`Cmd + K  Cmd+S` and `cmd+k cmd+s` are the same binding. A binding may chain at most
`MAX_SHORTCUT_CHORDS` (2) chords; the schema rejects longer sequences rather than silently storing
an unreachable one.

Presentation is separate: `formatShortcut` renders `cmd+k cmd+s` as `⌘K ⌘S`, and
`formatShortcutChords` returns the keycaps grouped per chord so `ShortcutBadge` can space the two
presses apart.

## Dispatch

One capture-phase `keydown` listener on the window owns dispatch
(`apps/desktop/src/renderer/src/commands/use-command-shortcuts.ts`). Capture phase is what lets an
opted-in command run before xterm or Monaco consume the event.

Sequences add one bit of state: the **pending chord**:

1. A keystroke whose chord is a _leading chord_ arms the pending chord instead of dispatching.
2. The next keystroke is joined to it (`cmd+k` + `cmd+s` → `cmd+k cmd+s`) and looked up in the same
   table.
3. Anything else clears the pending chord. A mouse press or losing the window clears it too, so a
   half-typed sequence never completes from an unrelated later keystroke.

A lone modifier press is skipped entirely: typing `Cmd+K Cmd+S` by releasing and re-pressing
Command emits a bare `Meta` keydown in between, which would otherwise cancel the sequence.

A Caxri-owned sequence that matches nothing is swallowed rather than released, so the second
keystroke of an abandoned chord cannot leak into a Terminal or an input. Escape is the exception:
Escape ends the sequence and still reaches whatever is listening; an accidental `Cmd+K` over a
dialog must not also eat the press that closes it.

A pending chord is visible. While Caxri owns an armed sequence, a small hint above the status bar
names the pressed chord ("was pressed. Waiting for the second key…") and lists every live binding
that continues it with its command title, built from the same table as the Keyboard Shortcuts sheet
(`features/keyboard-shortcuts/chord-hints.ts`), so a rebound or removed default shows correctly. The
hint disappears when the sequence completes, on Escape, on a non-matching key, on a mouse press or
window blur, and after 5 seconds, when the armed chord itself also expires so the hint and the
swallowed second key never disagree. A sequence released to Monaco shows no hint: the editor draws
its own chord feedback.
Continuations also bypass
the editable-surface policy (`allowInEditable`): the leading chord was already consumed by Caxri,
and a two-chord sequence can never be text the focused surface was about to receive. That is what
makes `Cmd+K Cmd+S` work with a Terminal focused.

### Leading chords, and why `Cmd+K` is reserved

`buildChordLeadingChords` (`packages/protocol/src/configuration/config-files.ts`) returns the chords
that open a sequence: every leading chord in the live table, plus `cmd+k`, which is reserved
unconditionally.

The reservation is load-bearing. Deriving the set from the table alone means removing the last
`cmd+k …` binding turns `Cmd+K` back into an ordinary chord, and then the second keystroke of
`Cmd+K Cmd+1` resolves as a standalone `Cmd+1` and switches to the first Pinned Session instead of
folding the editor region. Monaco's chords exist whether or not Caxri's table mentions them.

A single-chord binding on a leading chord can therefore never fire. `findKeybindingConflicts`
reports it with `reason: 'chordPrefix'` (including on the reserved `cmd+k` with no sequence present)
so Settings can say "Never fires" instead of the misleading "Conflicts with". The sequence itself
keeps working and is not reported. `reconcileDefaultKeybindings` treats a leading chord as occupied
so a shipped default is never added on top of one.

## Ownership: Caxri or Monaco

Caxri and the embedded Monaco editor run **two independent keybinding resolvers**. Monaco's
`StandaloneKeybindingService` keeps its own chord state, and Caxri cannot observe it. Guessing
whether Monaco is mid-chord is not possible, so ownership is decided once, at the leading chord,
from what is focused:

| Focus at the leading chord | Who owns the whole sequence                                           |
| -------------------------- | --------------------------------------------------------------------- |
| The Monaco editor          | Monaco. Caxri releases the leading chord and yields the continuation. |
| Anywhere else              | Caxri. Both keystrokes are consumed.                                  |

Ownership follows the first keystroke even if focus moves in between, because Monaco's own chord
state was already armed by then.

This is why `Cmd+K Cmd+0` still folds and `Cmd+K Cmd+J` still unfolds inside the editor without
Caxri registering either one, and why an app sequence on the same opener is deliberately inert while
the editor is focused. The consequence is accepted: a `cmd+k …` binding does not reach the editor.

## The native menu

Electron accelerators are one key combination, so a chord sequence has no accelerator form. Two
rules in `apps/desktop/src/main/menu/template.ts` keep the native menu out of the chord machine:

- A command bound to a sequence gets no accelerator. Its menu item advertises the binding as a label
  hint instead: `Edit Keyboard Shortcuts [⌘K ⌘S]`.
- A command bound to a _leading chord_ also gets no accelerator. A native accelerator fires from the
  keystroke itself, so registering `Cmd+K` would consume it before the Renderer could arm the
  pending chord, and the whole `Cmd+K …` family would stop working.

Right-click menus reuse the same presentation. `apps/desktop/src/main/context-menu.ts` renders an
entry's single-chord hint as a native accelerator with `registerAccelerator: false` (the command's
own binding already dispatches it, so the menu must not fire it a second time) and appends a
sequence to the label the same way.

## Defaults and migration

Shipped defaults live in `packages/protocol/src/domain/default-keybindings.ts`. A user's
`keybindings.jsonc` is never regenerated; reviewed changes to the defaults are applied through
`defaultKeybindingChanges`, which fails closed: a replacement needs exactly one matching old
default and a free destination chord, and an addition needs both a missing command and a free chord.
`releasedDefaultKeybindingGenerations` pins every released default table so the migration is
exercised against each of them.

`Cmd+K` was `terminal.clear` before chords existed. It is now the sequence opener, and Terminal
Clear ships on `Cmd+Shift+K`, migrated by a `replace` entry that is ordered ahead of the `cmd+k …`
additions: the chord has to be free before a sequence can claim it.

The last entry of `releasedDefaultKeybindingGenerations` is the one exception to "never rewrite a
generation", and only while its version is still untagged. `command-catalog.test.ts` asserts that
entry equals `defaultKeybindings`, so it is the current default set rather than history. A default
that ships and is withdrawn inside a single unreleased version is therefore edited there in place,
rather than earning a `replace` nobody could ever have stored, which is what happened to
`cmd+4` / `secondarySidebar.showActivity`. Once the version is tagged the entry freezes like every
one above it.

`Cmd+Shift+W` (Close Open Session) is a plain `add` entry in `defaultKeybindingChanges`; `Cmd+W`
(`workbench.closeActiveTab`) keeps its binding but no longer archives a Session when it closes the
last tab (see [open-sessions.md](open-sessions.md#shortcuts)). `Cmd+K Cmd+W`
(`workbench.closeOtherTabs`) is the keyboard form of the tab menu's Close Others in the active pane.
VS Code binds the same sequence to Close All Editors; Caxri keeps the active tab because `Cmd+W`
already closes it.

`Cmd+Shift+T` (`workbench.reopenClosedItem`) is the browser and VS Code "reopen closed tab" chord. It
reaches through a focused Terminal or Chat composer and is a plain `add` entry in
`defaultKeybindingChanges`. See [open-sessions.md](open-sessions.md#reopening-closed-tabs-and-sessions)
for what it reopens.

`Cmd+Alt+N` (`editor.newUntitledFile`) is VS Code's macOS New Untitled Text File chord. Caxri does
not take bare `Cmd+N`, which VS Code uses for the same command, because Caxri binds it to a new
Session.

## Contextual bindings (`when`)

A binding may carry `"when": "terminalFocus"`, the only context the schema accepts today.
`resolveShortcutBinding` walks a chord's bindings in file order and takes the first whose context is
active, so a contextual binding and an unconditional one can share a chord.

This is how Caxri shares a chord with Monaco rather than taking it away. Terminal Clear is
`allowInEditable`, so an ungated `cmd+shift+k` would fire out of a focused editor (which is
Monaco's Delete Line) whenever the Session merely had a Terminal. The gate is what keeps both
commands alive on one chord, and it is what VS Code does for the same command.

The gate applies to keystroke dispatch only. The command palette, the native menu, the Terminal
context menu, and the shortcut hints they display all read the command's own availability, so Clear
Terminal stays listed and runnable with its `⇧⌘K` hint while focus is elsewhere.
