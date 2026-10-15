import { describe, expect, it } from 'vitest';

import { rankPaletteEntries } from '../command-palette-search';

const entries = [
    { id: 'project', value: 'Example Components Project /workspace/Example Components' },
    { id: 'session', value: 'Compile an app with retries Session example-session' },
    {
        id: 'command',
        value: 'Compact Recently Idle Sessions Session command.compact 压缩最近空闲的会话',
    },
];

describe('palette search ordering', () => {
    it('ranks a command prefix before weak matches across result kinds', () => {
        expect(rankPaletteEntries(entries, 'compa')[0]?.id).toBe('command');
        expect(rankPaletteEntries(entries, '压缩')[0]?.id).toBe('command');
    });

    it('restores the same ranking when the query is widened again', () => {
        const initial = rankPaletteEntries(entries, 'compa');
        expect(rankPaletteEntries(entries, 'compac')[0]?.id).toBe('command');
        expect(rankPaletteEntries(entries, 'compa')).toEqual(initial);
        expect(rankPaletteEntries(entries, '  ')).toEqual(entries);
        expect(entries[0]?.id).toBe('project');
    });

    it('excludes nonmatches and preserves both equal-titled entries in source order', () => {
        expect(rankPaletteEntries(entries, 'qqzzxv')).toEqual([]);
        const repeated = [
            { id: 'first', value: 'Example Session' },
            { id: 'second', value: 'Example Session' },
        ];
        expect(rankPaletteEntries(repeated, 'example').map(({ id }) => id)).toEqual([
            'first',
            'second',
        ]);
    });
});
