import { sortedCopy } from '@caxri/utils';

/**
 * Canonical chord normalization shared by dispatch, editing, and conflict detection.
 */
export function normalizeShortcut(value: string): string {
    const parts = value
        .toLowerCase()
        .replaceAll('command', 'cmd')
        .split('+')
        .map((part) => part.trim());
    return sortedCopy(parts, (a, b) => {
        const order = ['cmd', 'ctrl', 'alt', 'shift'];
        const left = order.indexOf(a);
        const right = order.indexOf(b);
        return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    }).join('+');
}

const MODIFIER_SYMBOLS: Record<string, string> = {
    alt: '⌥',
    cmd: '⌘',
    ctrl: '⌃',
    shift: '⇧',
};

/**
 * MacOS presents modifiers in Control, Option, Shift, Command order.
 */
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

/**
 * Formats one chord as keycap-sized parts in macOS modifier order.
 */
export function formatShortcutParts(key: string): string[] {
    const parts = normalizeShortcut(key).split('+');
    const partSet = new Set(parts);
    const symbols = MODIFIER_DISPLAY_ORDER.filter((modifier) => partSet.has(modifier)).map(
        (modifier) => MODIFIER_SYMBOLS[modifier],
    );
    const mainKey = parts.find((part) => !Object.hasOwn(MODIFIER_SYMBOLS, part)) ?? '';
    const displayKey =
        KEY_SYMBOLS[mainKey] ?? (mainKey.length === 1 ? mainKey.toUpperCase() : mainKey);
    return displayKey ? [...symbols, displayKey] : symbols;
}

/**
 * Formats a keybinding chord for accessible text, for example `cmd+shift+p` becomes `⇧⌘P`.
 */
export function formatShortcut(key: string): string {
    return formatShortcutParts(key).join('');
}
