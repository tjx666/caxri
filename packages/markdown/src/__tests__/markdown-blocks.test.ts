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
                    { blocks: [{ type: 'paragraph', children: [{ type: 'text', value: 'one' }] }] },
                    {
                        blocks: [
                            {
                                type: 'paragraph',
                                children: [
                                    {
                                        type: 'emphasis',
                                        children: [{ type: 'text', value: 'two' }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                type: 'quote',
                children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
            },
            { type: 'code', value: 'const a = 1;', language: 'ts' },
        ]);
    });

    it('keeps tables when asked, aligned and padded to the header width', () => {
        const source = [
            '| Name | **Size** | Note |',
            '| :--- | ---: | :-: |',
            '| a | 1 |',
            '| b | 2 | `x` | extra |',
        ].join('\n');
        const text = (value: string) => [{ type: 'text', value }];
        expect(parseMarkdownBlocks(source, { tables: true })).toEqual([
            {
                type: 'table',
                align: ['left', 'right', 'center'],
                header: [text('Name'), [{ type: 'strong', children: text('Size') }], text('Note')],
                rows: [
                    [text('a'), text('1'), []],
                    [text('b'), text('2'), [{ type: 'code', value: 'x' }]],
                ],
            },
        ]);
        expect(parseMarkdownBlocks(source)).toEqual([]);
    });

    it('keeps heading levels, an ordered list start, and task markers', () => {
        const text = (value: string) => [{ type: 'text', value }];
        expect(
            parseMarkdownBlocks(
                ['## Plan', '', '3. third', '4. fourth', '', '- [x] done', '- [ ] todo'].join('\n'),
            ),
        ).toEqual([
            { type: 'heading', level: 2, children: text('Plan') },
            {
                type: 'list',
                ordered: true,
                start: 3,
                items: [
                    { blocks: [{ type: 'paragraph', children: text('third') }] },
                    { blocks: [{ type: 'paragraph', children: text('fourth') }] },
                ],
            },
            {
                type: 'list',
                ordered: false,
                items: [
                    { blocks: [{ type: 'paragraph', children: text('done') }], checked: true },
                    { blocks: [{ type: 'paragraph', children: text('todo') }], checked: false },
                ],
            },
        ]);
    });

    it('marks local file links and path-like inline code only when file links are enabled', () => {
        const source =
            'Fixed [store.ts](/repo/src/store.ts:42), [docs](file:///repo/docs/a%20b.md), and `src/app.tsx:7` but not `console.log`.';
        const [paragraph] = parseMarkdownBlocks(source, { fileLinks: true });
        expect(paragraph).toEqual({
            type: 'paragraph',
            children: [
                { type: 'text', value: 'Fixed ' },
                {
                    type: 'link',
                    href: undefined,
                    file: '/repo/src/store.ts:42',
                    children: [{ type: 'text', value: 'store.ts' }],
                },
                { type: 'text', value: ', ' },
                {
                    type: 'link',
                    href: undefined,
                    file: '/repo/docs/a b.md',
                    children: [{ type: 'text', value: 'docs' }],
                },
                { type: 'text', value: ', and ' },
                { type: 'code', value: 'src/app.tsx:7', file: 'src/app.tsx:7' },
                { type: 'text', value: ' but not ' },
                { type: 'code', value: 'console.log' },
                { type: 'text', value: '.' },
            ],
        });
        expect(JSON.stringify(parseMarkdownBlocks(source))).not.toContain('"file"');
    });
});
