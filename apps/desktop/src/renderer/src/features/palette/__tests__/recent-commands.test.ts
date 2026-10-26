import { describe, expect, it } from 'vitest';

import {
    parseRecentCommands,
    pushRecentCommand,
    RECENT_COMMANDS_LIMIT,
    visibleRecentCommands,
} from '../recent-commands';

describe('pushRecentCommand', () => {
    it('puts the newest command first and promotes a repeat instead of listing it twice', () => {
        expect(pushRecentCommand(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
        expect(pushRecentCommand([], 'a')).toEqual(['a']);
    });

    it('keeps only the newest few', () => {
        const full = Array.from({ length: RECENT_COMMANDS_LIMIT }, (_, index) => `c${index}`);
        const next = pushRecentCommand(full, 'new');
        expect(next).toHaveLength(RECENT_COMMANDS_LIMIT);
        expect(next[0]).toBe('new');
        expect(next).not.toContain(`c${RECENT_COMMANDS_LIMIT - 1}`);
    });
});

describe('parseRecentCommands', () => {
    it('treats anything but a list of strings as empty', () => {
        expect(parseRecentCommands(undefined)).toEqual([]);
        expect(parseRecentCommands({ a: 1 })).toEqual([]);
        expect(parseRecentCommands(['a', 3, 'b'])).toEqual(['a', 'b']);
    });
});

describe('visibleRecentCommands', () => {
    it('drops commands that are not offered right now, keeping order', () => {
        expect(visibleRecentCommands(['a', 'b', 'c'], new Set(['c', 'a']))).toEqual(['a', 'c']);
    });
});
