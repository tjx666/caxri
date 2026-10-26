import type { Keybinding } from '@caxri/protocol';

import type { KeyboardShortcutLabels } from './keyboard-shortcut-groups';
import { buildKeyboardShortcutGroups } from './keyboard-shortcut-groups';

/**
 * One way to finish an armed chord: the second keystroke and what it runs.
 */
export interface ChordHint {
    command: string;
    /**
     * Only the keystroke that completes the sequence (`cmd+s`), not the whole `cmd+k cmd+s` binding.
     */
    secondKey: string;
    title: string;
}

/**
 * Lists every live binding that continues `leadingChord`, in the cheatsheet's order, so the hint after `Cmd+K` shows
 * exactly what the Keyboard Shortcuts sheet lists under that prefix and a rebound or removed default is reflected
 * without a second source of truth. Titles come from the same resolver as the sheet, which also drops bindings that
 * have nothing honest to call them.
 */
export function buildChordHints(
    keybindings: readonly Keybinding[],
    leadingChord: string,
    contributedCommands: ReadonlyArray<{ id: string; title: string }>,
    labels: KeyboardShortcutLabels,
): ChordHint[] {
    const prefix = `${leadingChord} `;
    const continuations = keybindings.filter((binding) => binding.key.startsWith(prefix));
    return buildKeyboardShortcutGroups(continuations, contributedCommands, labels)
        .flatMap((group) => group.entries)
        .flatMap((entry) =>
            entry.keys.map((key) => ({
                command: entry.command,
                secondKey: key.slice(prefix.length),
                title: entry.titleLabel,
            })),
        );
}
