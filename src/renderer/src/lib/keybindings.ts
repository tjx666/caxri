import { useMemo } from 'react';

import type { CommandId, Keybinding } from '@shared/types';
import { normalizeShortcut } from '@shared/shortcuts';

import { useWorkbenchStore } from '../stores/workbench';

/**
 * macOS composes Option+<letter> into a symbol: `Option+P` reports `event.key === 'π'`, so a chord
 * built from `event.key` could never match a stored `alt+p` — every Option+letter binding was dead,
 * both at dispatch and while recording one in Settings. Alt chords therefore read the physical
 * `event.code`, which stays stable for the letter and digit rows. Non-Alt chords keep using
 * `event.key` so a remapped or non-US layout still records what the user actually typed.
 */
function shortcutMainKey(event: KeyboardEvent): string {
    if (event.altKey) {
        const letter = /^Key([A-Z])$/.exec(event.code);
        if (letter) return letter[1].toLowerCase();
        const digit = /^Digit(\d)$/.exec(event.code);
        if (digit) return digit[1];
    }
    const mainKey = event.key === ' ' ? 'space' : event.key;
    return mainKey.length === 1 ? mainKey : mainKey.toLowerCase();
}

export function keyboardEventShortcut(event: KeyboardEvent): string {
    return normalizeShortcut(
        [
            event.metaKey && 'cmd',
            event.ctrlKey && 'ctrl',
            event.altKey && 'alt',
            event.shiftKey && 'shift',
            shortcutMainKey(event),
        ]
            .filter(Boolean)
            .join('+'),
    );
}

/**
 * Normalized chord -> command id, built once per keybinding change instead of scanning the whole
 * table on every keystroke. The first binding for a given chord wins, matching the previous
 * `Array#find` behaviour when the keybinding source declares a duplicate.
 */
export function buildShortcutMap(keybindings: Keybinding[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const binding of keybindings) {
        const chord = normalizeShortcut(binding.key);
        if (!map.has(chord)) map.set(chord, binding.command);
    }
    return map;
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable], .monaco-editor, .xterm';

/**
 * True when the event target is (or is nested inside) an editable surface: a form control, a
 * `contenteditable` region, the Monaco editor, or an xterm pane. Global shortcuts must stand down
 * for these unless the matched command opts in with `allowInEditable`.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

const MODIFIER_SYMBOLS: Record<string, string> = {
    alt: '⌥',
    cmd: '⌘',
    ctrl: '⌃',
    shift: '⇧',
};

/** macOS modifier display order: Control, Option, Shift, Command. */
const MODIFIER_DISPLAY_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];

const KEY_SYMBOLS: Record<string, string> = {
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    backspace: '⌫',
    delete: '⌦',
    enter: '↵',
    escape: 'Esc',
    space: 'Space',
    tab: '⇥',
};

/** Formats one chord as keycap-sized parts in the shared macOS modifier order. */
export function formatShortcutParts(key: string): string[] {
    const parts = normalizeShortcut(key).split('+');
    const partSet = new Set(parts);
    const symbols = MODIFIER_DISPLAY_ORDER.filter((modifier) => partSet.has(modifier)).map(
        (modifier) => MODIFIER_SYMBOLS[modifier],
    );
    const mainKey = parts.find((part) => !(part in MODIFIER_SYMBOLS)) ?? '';
    const displayKey =
        KEY_SYMBOLS[mainKey] ?? (mainKey.length === 1 ? mainKey.toUpperCase() : mainKey);
    return displayKey ? [...symbols, displayKey] : symbols;
}

/** Formats a keybinding chord for accessible text, e.g. `cmd+shift+p` -> `⇧⌘P`. */
export function formatShortcut(key: string): string {
    return formatShortcutParts(key).join('');
}

/** Looks up the live raw keybinding for a command; presentation belongs to `ShortcutBadge`. */
export function useCommandShortcut(commandId: CommandId): string | undefined {
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings);
    return useMemo(() => {
        const binding = keybindings?.find((item) => item.command === commandId);
        return binding?.key;
    }, [keybindings, commandId]);
}
