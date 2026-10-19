import { commandDefinitions } from '@caxri/protocol';
import { commands as zhCommands } from '@desktop-shared/i18n/zh-cn/commands';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { staticCommandSearchEntry } from '../command-palette-commands';
import type { PaletteSearchEntry } from '../palette-search';
import { paletteSearchScore } from '../palette-search';

const zhCN: Readonly<Record<string, string>> = zhCommands;
const translateZhCN: Translate = (key) => zhCN[key] ?? key;

function rank(entries: ReadonlyArray<[string, PaletteSearchEntry]>, query: string): string[] {
    return entries
        .map(([key, entry]) => [key, paletteSearchScore(entry, query)] as const)
        .filter(([, score]) => score > 0)
        .toSorted((a, b) => b[1] - a[1])
        .map(([key]) => key);
}

describe('paletteSearchScore', () => {
    it('ranks the Chinese-titled compact command first for an English prefix', () => {
        const entries: Array<[string, PaletteSearchEntry]> = [
            [
                'session:fixture',
                {
                    titles: ['Refactor billing parser'],
                    details: ['sample-app', '/tmp/workspace/compa-notes/sample-app', 'fixture'],
                },
            ],
            ...commandDefinitions.map((command): [string, PaletteSearchEntry] => [
                command.id,
                staticCommandSearchEntry(command, translateZhCN),
            ]),
        ];
        expect(rank(entries, 'compa')[0]).toBe('session.compactWarm');
    });

    it('orders title words above keywords above details above fuzzy hits', () => {
        const query = 'deploy';
        const title = paletteSearchScore({ titles: ['Open Deploy Log'] }, query);
        const term = paletteSearchScore({ titles: ['Open Log'], terms: ['deployment'] }, query);
        const detail = paletteSearchScore(
            { titles: ['Open Log'], details: ['Shows the deploy output'] },
            query,
        );
        const fuzzy = paletteSearchScore({ titles: ['Delete Project Layout'] }, query);
        expect(title).toBeGreaterThan(term);
        expect(term).toBeGreaterThan(detail);
        expect(detail).toBeGreaterThan(fuzzy);
    });

    it('matches camelCase ids and contiguous CJK text as words', () => {
        expect(paletteSearchScore({ titles: ['X'], terms: ['session.compactWarm'] }, 'warm')).toBe(
            0.75,
        );
        expect(paletteSearchScore({ titles: ['压缩最近空闲的会话'] }, '空闲')).toBe(0.9);
    });

    it('requires every token to match and ranks by the weakest', () => {
        const entry = { titles: ['Compact Recently Idle Sessions'], terms: ['context'] };
        expect(paletteSearchScore(entry, 'compact idle')).toBe(0.9);
        expect(paletteSearchScore(entry, 'compact context')).toBe(0.75);
        expect(paletteSearchScore(entry, 'compact zzz')).toBe(0);
    });

    it('keeps every row for an empty query', () => {
        expect(paletteSearchScore({ titles: ['Anything'] }, '  ')).toBe(1);
    });
});
