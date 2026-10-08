import { describe, expect, it } from 'vitest';

import {
    formatShortcut,
    formatShortcutChords,
    normalizeShortcut,
    shortcutLeadingChord,
    splitShortcutChords,
} from '../shortcuts';

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

    it('normalizes every chord of a whitespace-separated sequence', () => {
        expect(normalizeShortcut('Cmd+K  Shift+Cmd+S')).toBe('cmd+k cmd+shift+s');
        expect(normalizeShortcut('cmd+k v')).toBe('cmd+k v');
    });

    /**
     * Whitespace is the chord separator, so it must not also survive around a `+`: otherwise the long-standing `Cmd +
     * K` spelling would silently become three chords.
     */
    it('keeps whitespace around a plus inside one chord', () => {
        expect(splitShortcutChords(' Cmd + K ')).toEqual(['cmd+k']);
        expect(splitShortcutChords('cmd+k cmd+s')).toEqual(['cmd+k', 'cmd+s']);
    });

    it('is idempotent on an already-normalized sequence', () => {
        const normalized = normalizeShortcut('Cmd+K Cmd+S');
        expect(normalizeShortcut(normalized)).toBe(normalized);
    });
});

describe('shortcutLeadingChord', () => {
    it('reports the opening chord of a sequence and nothing for a single chord', () => {
        expect(shortcutLeadingChord('Cmd+K Cmd+S')).toBe('cmd+k');
        expect(shortcutLeadingChord('cmd+k')).toBeUndefined();
    });
});

describe('shortcut presentation', () => {
    it('uses macOS modifier order and symbols', () => {
        expect(formatShortcutChords('command+alt+shift+p')).toEqual([['⌥', '⇧', '⌘', 'P']]);
        expect(formatShortcut('command+alt+shift+p')).toBe('⌥⇧⌘P');
    });

    it('groups a sequence per chord and spaces the chords apart in text', () => {
        expect(formatShortcutChords('cmd+k cmd+s')).toEqual([
            ['⌘', 'K'],
            ['⌘', 'S'],
        ]);
        expect(formatShortcut('cmd+k cmd+s')).toBe('⌘K ⌘S');
        expect(formatShortcut('cmd+k v')).toBe('⌘K V');
    });

    it('formats named keys consistently', () => {
        expect(formatShortcut('ctrl+shift+tab')).toBe('⌃⇧⇥');
        expect(formatShortcut('cmd+`')).toBe('⌘`');
        expect(formatShortcut('cmd+arrowleft')).toBe('⌘←');
        expect(formatShortcut('escape')).toBe('Esc');
    });
});
