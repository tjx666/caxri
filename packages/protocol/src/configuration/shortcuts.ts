import { sortedCopy } from '@caxri/utils';

/**
 * Upper bound on chords in one keybinding. VS Code allows longer sequences; two covers every `Cmd+K <key>` binding
 * Caxri needs and keeps dispatch to a single pending chord instead of a general prefix trie.
 */
export const MAX_SHORTCUT_CHORDS = 2;

/**
 * Canonical normalization for one chord, a single key combination such as `cmd+shift+k`.
 */
function normalizeChord(value: string): string {
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

/**
 * Splits a keybinding into its normalized chords. Chords are separated by whitespace, VS Code style (`cmd+k cmd+s`).
 * Whitespace surrounding a `+` belongs to the chord it joins, so `Cmd + K` stays one chord rather than three.
 */
export function splitShortcutChords(value: string): string[] {
    return value
        .trim()
        .replaceAll(/\s*\+\s*/g, '+')
        .split(/\s+/)
        .filter(Boolean)
        .map(normalizeChord);
}

/**
 * Canonical keybinding normalization shared by dispatch, editing, and conflict detection.
 */
export function normalizeShortcut(value: string): string {
    return splitShortcutChords(value).join(' ');
}

/**
 * The chord that opens a multi-chord keybinding, or `undefined` when the keybinding is a single chord. Dispatch arms
 * its pending state on this chord, and conflict detection uses it to find a single-chord binding the sequence shadows.
 */
export function shortcutLeadingChord(value: string): string | undefined {
    const chords = splitShortcutChords(value);
    return chords.length > 1 ? chords[0] : undefined;
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

function formatChordParts(chord: string): string[] {
    const parts = chord.split('+');
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
 * Formats a keybinding as keycap-sized parts grouped per chord, so a presenter can space the chords of a sequence
 * apart: `cmd+k cmd+s` becomes `[['⌘', 'K'], ['⌘', 'S']]`.
 */
export function formatShortcutChords(key: string): string[][] {
    return splitShortcutChords(key).map(formatChordParts);
}

/**
 * Formats a keybinding for accessible text: `cmd+shift+p` becomes `⇧⌘P` and `cmd+k cmd+s` becomes `⌘K ⌘S`.
 */
export function formatShortcut(key: string): string {
    return formatShortcutChords(key)
        .map((parts) => parts.join(''))
        .join(' ');
}
