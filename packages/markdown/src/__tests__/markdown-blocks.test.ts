import { describe, expect, it } from 'vitest';

import { parseMarkdownBlocks } from '../markdown-blocks.js';

describe('parseMarkdownBlocks', () => {
    it('drops raw HTML and reduces images to alt text in a review-bot comment', () => {
        const blocks = parseMarkdownBlocks(
            [
                '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub> Retry the handoff**',
                '',
                'If `resumeAbandonedParent` throws here, see [AGENTS.md:L77](https://example.com/AGENTS.md#L77).',
            ].join('\n'),
        );
        expect(blocks).toEqual([
            {
                type: 'paragraph',
                children: [
                    {
                        type: 'strong',
                        children: [{ type: 'text', value: 'P1 Badge Retry the handoff' }],
                    },
                ],
            },
            {
                type: 'paragraph',
                children: [
                    { type: 'text', value: 'If ' },
                    { type: 'code', value: 'resumeAbandonedParent' },
                    { type: 'text', value: ' throws here, see ' },
                    {
                        type: 'link',
                        href: 'https://example.com/AGENTS.md#L77',
                        children: [{ type: 'text', value: 'AGENTS.md:L77' }],
                    },
                    { type: 'text', value: '.' },
                ],
            },
        ]);
    });

    it('keeps link text but withholds a destination that is not absolute HTTP(S)', () => {
        const [paragraph] = parseMarkdownBlocks(
            '[mail](mailto:someone@example.com) and [doc](./guide.md)',
        );
        expect(paragraph).toEqual({
            type: 'paragraph',
            children: [
                { type: 'link', href: undefined, children: [{ type: 'text', value: 'mail' }] },
                { type: 'text', value: ' and ' },
                { type: 'link', href: undefined, children: [{ type: 'text', value: 'doc' }] },
            ],
        });
    });

    it('drops HTML blocks and tables while keeping lists, quotes, and code', () => {
        const blocks = parseMarkdownBlocks(
            [
                '<details><summary>Hidden</summary></details>',
                '',
                '| a |',
                '| - |',
                '| 1 |',
                '',
                '- one',
                '- *two*',
                '',
                '> quoted',
                '',
                '```ts',
                'const a = 1;',
                '```',
            ].join('\n'),
        );
        expect(blocks).toEqual([
            {
                type: 'list',
                ordered: false,
                items: [
                    [{ type: 'paragraph', children: [{ type: 'text', value: 'one' }] }],
                    [
                        {
                            type: 'paragraph',
                            children: [
                                { type: 'emphasis', children: [{ type: 'text', value: 'two' }] },
                            ],
                        },
                    ],
                ],
            },
            {
                type: 'quote',
                children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
            },
            { type: 'code', value: 'const a = 1;' },
        ]);
    });
});
