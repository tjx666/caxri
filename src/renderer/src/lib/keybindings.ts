import { useMemo } from 'react';

import type { Keybinding } from '@shared/types';

import { useWorkbenchStore } from '../stores/workbench';

/** Shortcut normalization shared by the keybinding table and the global keydown dispatcher. */
function normalizeShortcut(value: string): string {
    return value
        .toLowerCase()
        .replaceAll('command', 'cmd')
        .split('+')
        .map((part) => part.trim())
        .sort((a, b) => {
            const order = ['cmd', 'ctrl', 'alt', 'shift'];
            const left = order.indexOf(a);
            const right = order.indexOf(b);
            return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
        })
        .join('+');
}

export function keyboardEventShortcut(event: KeyboardEvent): string {
    return normalizeShortcut(
        [
            event.metaKey && 'cmd',
            event.ctrlKey && 'ctrl',
            event.altKey && 'alt',
            event.shiftKey && 'shift',
            event.key.length === 1 ? event.key : event.key.toLowerCase(),
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

/** Formats a keybinding chord for display, e.g. `cmd+shift+p` -> `⌘⇧P`. */
function formatShortcut(key: string): string {
    const parts = normalizeShortcut(key).split('+');
    const symbols = MODIFIER_DISPLAY_ORDER.filter((modifier) => parts.includes(modifier)).map(
        (modifier) => MODIFIER_SYMBOLS[modifier],
    );
    const mainKey = parts.find((part) => !(part in MODIFIER_SYMBOLS)) ?? '';
    return [...symbols, mainKey.length === 1 ? mainKey.toUpperCase() : mainKey].join('');
}

/** Looks up the live keybinding for a command and formats it for display, e.g. `'⌘K'`. */
export function useCommandShortcut(commandId: string): string | undefined {
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings);
    return useMemo(() => {
        const binding = keybindings?.find((item) => item.command === commandId);
        return binding ? formatShortcut(binding.key) : undefined;
    }, [keybindings, commandId]);
}
