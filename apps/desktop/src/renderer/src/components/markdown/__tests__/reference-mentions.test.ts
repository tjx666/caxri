import { describe, expect, it } from 'vitest';

import {
    isSameReferenceMentionIndex,
    referenceMentionIndex,
    referenceMentionSegments,
} from '../reference-mentions';

const PULL = 'https://github.com/acme/app/pull/12';

describe('referenceMentionIndex', () => {
    it('keys numbered GitHub links and Linear issues by how prose mentions them', () => {
        expect(
            Object.fromEntries(
                referenceMentionIndex([
                    `${PULL}/files`,
                    'https://github.com/acme/app/issues/7#issuecomment-1',
                    'https://linear.app/acme/issue/eng-42/fix-the-bar',
                    'https://github.com/acme/app',
                    'https://example.com/#3',
                ]),
            ),
        ).toEqual({
            '#12': PULL,
            '#7': 'https://github.com/acme/app/issues/7',
            'ENG-42': 'https://linear.app/acme/issue/ENG-42',
        });
    });

    it('drops a number two repositories share, and keeps the first link of one repository', () => {
        const index = referenceMentionIndex([
            PULL,
            'https://github.com/other/lib/issues/12',
            'https://github.com/acme/app/pull/5',
            'https://github.com/ACME/app/issues/5',
        ]);
        expect(index.has('#12')).toBe(false);
        expect(index.get('#5')).toBe('https://github.com/acme/app/pull/5');
    });
});

describe('referenceMentionSegments', () => {
    const index = referenceMentionIndex([PULL, 'https://linear.app/acme/issue/ENG-42']);

    it('splits out resolved mentions, including one right after CJK text', () => {
        expect(referenceMentionSegments('完成后#12 要等 ENG-42 合并', index)).toEqual([
            { kind: 'text', text: '完成后' },
            { kind: 'mention', text: '#12', href: PULL },
            { kind: 'text', text: ' 要等 ' },
            {
                kind: 'mention',
                text: 'ENG-42',
                href: 'https://linear.app/acme/issue/ENG-42',
            },
            { kind: 'text', text: ' 合并' },
        ]);
    });

    it('leaves unknown numbers, fragments, entities, and glued tokens as text', () => {
        for (const text of [
            'see #13',
            'a#12',
            '/#12',
            '&#12;',
            '#123',
            '#12a',
            'XENG-42',
            'ENG-420',
        ])
            expect(referenceMentionSegments(text, index)).toBeUndefined();
    });
});

describe('isSameReferenceMentionIndex', () => {
    it('compares entries, not identity', () => {
        expect(
            isSameReferenceMentionIndex(
                referenceMentionIndex([PULL]),
                referenceMentionIndex([PULL]),
            ),
        ).toBe(true);
        expect(
            isSameReferenceMentionIndex(
                referenceMentionIndex([PULL]),
                referenceMentionIndex(['https://github.com/acme/app/pull/13']),
            ),
        ).toBe(false);
    });
});
