import { describe, expect, it } from 'vitest';

import { formatShortcut, formatShortcutParts, normalizeShortcut } from '../shortcuts';

describe('normalizeShortcut', () => {
    it('lower-cases every part of the chord', () => {
        expect(normalizeShortcut('Cmd+Shift+K')).toBe('cmd+shift+k');
    });

    it('reorders modifiers into the canonical cmd/ctrl/alt/shift order', () => {
        expect(normalizeShortcut('shift+cmd+k')).toBe('cmd+shift+k');
        expect(normalizeShortcut('alt+ctrl+cmd+shift+k')).toBe('cmd+ctrl+alt+shift+k');
    });

    it('maps the spelled-out command modifier to cmd', () => {
        expect(normalizeShortcut('Command+K')).toBe('cmd+k');
    });

    it('trims whitespace around each part', () => {
        expect(normalizeShortcut(' Cmd + K ')).toBe('cmd+k');
    });

    it('keeps unrecognized modifiers and sorts them stably after known ones', () => {
        // `fn` is not in the canonical modifier order, so it sorts after cmd/ctrl/alt/shift; between
        // ties (fn and the trailing key `k`) the original relative order is preserved.
        expect(normalizeShortcut('Fn+Cmd+K')).toBe('cmd+fn+k');
    });

    it('leaves a single non-modifier key unchanged besides case-folding', () => {
        expect(normalizeShortcut('Escape')).toBe('escape');
        expect(normalizeShortcut('K')).toBe('k');
    });

    it('is idempotent when applied to an already-normalized chord', () => {
        const normalized = normalizeShortcut('Command+Shift+P');
        expect(normalizeShortcut(normalized)).toBe(normalized);
    });
});

describe('shortcut presentation', () => {
    it('uses macOS modifier order and symbols', () => {
        expect(formatShortcutParts('command+alt+shift+p')).toEqual(['⌥', '⇧', '⌘', 'P']);
        expect(formatShortcut('command+alt+shift+p')).toBe('⌥⇧⌘P');
    });

    it('formats named keys consistently', () => {
        expect(formatShortcut('ctrl+shift+tab')).toBe('⌃⇧⇥');
        expect(formatShortcut('cmd+`')).toBe('⌘`');
        expect(formatShortcut('cmd+arrowleft')).toBe('⌘←');
        expect(formatShortcut('escape')).toBe('Esc');
    });
});
