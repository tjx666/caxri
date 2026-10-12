import { describe, expect, it } from 'vitest';

import { parseMarkdownBlocks } from '../markdown-blocks.js';
import { isSameMarkdownTree } from '../markdown-equality.js';
import {
    blocksPlainText,
    inlinePlainText,
    tableToHtml,
    tableToMarkdown,
} from '../markdown-text.js';

const source = [
    '| Name | Size |',
    '| :-- | --: |',
    '| **a** | `1` |',
    String.raw`| b<c | x \| y |`,
].join('\n');

function parseTable() {
    const [table] = parseMarkdownBlocks(source, { tables: true });
    if (table?.type !== 'table') throw new Error('expected a table');
    return table;
}

describe('table copy text', () => {
    it('re-serializes a table as Markdown with alignment and escaped pipes', () => {
        expect(tableToMarkdown(parseTable())).toBe(
            ['| Name | Size |', '| :--- | ---: |', '| a | 1 |', String.raw`| b<c | x \| y |`].join(
                '\n',
            ),
        );
    });

    it('renders an escaped HTML table for rich paste targets', () => {
        expect(tableToHtml(parseTable())).toBe(
            '<table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b&lt;c</td><td>x | y</td></tr></tbody></table>',
        );
    });

    it('reduces inline formatting to its text', () => {
        const [paragraph] = parseMarkdownBlocks('**bold** and [link](https://example.com)  \nnext');
        expect(paragraph?.type === 'paragraph' && inlinePlainText(paragraph.children)).toBe(
            'bold and link next',
        );
    });
});

describe('isSameMarkdownTree', () => {
    it('matches separately parsed copies of the same block and rejects an edited one', () => {
        const [first] = parseMarkdownBlocks('- [x] done\n- `a.ts`');
        const [second] = parseMarkdownBlocks('- [x] done\n- `a.ts`');
        const [edited] = parseMarkdownBlocks('- [x] done\n- `b.ts`');
        expect(first).not.toBe(second);
        expect(isSameMarkdownTree(first, second)).toBe(true);
        expect(isSameMarkdownTree(first, edited)).toBe(false);
        expect(isSameMarkdownTree({ a: undefined }, { b: undefined })).toBe(false);
    });
});

describe('blocksPlainText', () => {
    const quoted = (markdown: string) => {
        const [quote] = parseMarkdownBlocks(markdown, { tables: true });
        if (quote?.type !== 'quote') throw new Error('expected a quote');
        return blocksPlainText(quote.children);
    };

    it('copies a quote as its words, without the quote markers or inline formatting', () => {
        expect(quoted('> Ship **it** with `bun`\n> today.')).toBe('Ship it with bun today.');
    });

    it('keeps paragraphs apart, hard breaks as line breaks, and lists with their markers', () => {
        expect(
            quoted(
                [
                    '> First line  ',
                    '> second line',
                    '>',
                    '> 1. one',
                    '>',
                    '>    more',
                    '> 2. two',
                    '>',
                    '> - [x] done',
                    '>',
                    '> > nested',
                ].join('\n'),
            ),
        ).toBe(
            ['First line\nsecond line', '1. one\n\n   more\n2. two', '- [x] done', 'nested'].join(
                '\n\n',
            ),
        );
    });

    it("keeps a fenced block's code and a table as Markdown", () => {
        expect(quoted('> ```ts\n> const a = 1;\n> ```\n>\n> | a |\n> | - |\n> | 1 |')).toBe(
            'const a = 1;\n\n| a |\n| --- |\n| 1 |',
        );
    });
});
