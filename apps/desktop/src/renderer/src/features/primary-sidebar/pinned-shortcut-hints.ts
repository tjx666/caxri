import type { Keybinding } from '@caxri/protocol';
import { sessionOpenPinnedCommandIds, splitShortcutChords } from '@caxri/protocol';

const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift'] as const;

/**
 * The modifiers a keyboard event holds, as a normalized chord prefix (`cmd`, `cmd+shift`), or `''` for none. Ordered
 * the way `normalizeShortcut` orders them, so it compares equal to a binding's own modifiers.
 */
export function heldModifierChord(event: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}): string {
    const held = {
        alt: event.altKey,
        cmd: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
    };
    return MODIFIER_ORDER.filter((modifier) => held[modifier]).join('+');
}

/**
 * The Switch to Pinned Session command whose chord reaches the row at `index` of `count` Pinned Sessions: positions 1
 * to 8 by number, and the last row through `9` once it sits past the eighth. Other rows have no chord.
 */
export function pinnedShortcutCommand(
    index: number,
    count: number,
): (typeof sessionOpenPinnedCommandIds)[number] | undefined {
    if (index < 8) return sessionOpenPinnedCommandIds[index];
    return index === count - 1 ? sessionOpenPinnedCommandIds[8] : undefined;
}

/**
 * The live binding to show on a Pinned row while `heldChord` is held: only a single-chord binding whose modifiers are
 * exactly the held ones, so holding Cmd reveals `⌘1` but holding Cmd+Shift does not, and a rebound command shows its
 * own chord.
 */
export function pinnedShortcutHint(
    keybindings: readonly Keybinding[] | undefined,
    command: string | undefined,
    heldChord: string,
): string | undefined {
    if (!command || !heldChord) return undefined;
    const key = keybindings?.find((binding) => binding.command === command)?.key;
    if (!key) return undefined;
    const chords = splitShortcutChords(key);
    if (chords.length !== 1) return undefined;
    const modifiers = chords[0]
        .split('+')
        .filter((part) => (MODIFIER_ORDER as readonly string[]).includes(part))
        .join('+');
    return modifiers === heldChord ? key : undefined;
}
