import { describe, expect, it } from 'vitest';

import type { MarkdownBlockOptions } from '../markdown-blocks.js';
import { parseMarkdownBlocks } from '../markdown-blocks.js';
import { createStreamingMarkdownParser } from '../streaming-parser.js';
import { repairStreamingMarkdown } from '../streaming-repair.js';
import { agentReplyFixture, streamingPrefixes } from './agent-reply.fixture.js';

const CHAT_OPTIONS: MarkdownBlockOptions = { tables: true, fileLinks: true };

/**
 * Sources whose block boundaries depend on text that arrives after a construct starts. Each is streamed one character
 * at a time, so every partial line is exercised.
 */
const BOUNDARY_CASES: Record<string, string> = {
    'ordered item after a paragraph-looking digit':
        '1. one\n2. two\n\n3. three\n\n10) other\n\nend',
    'setext heading underline': 'intro\n\nTitle\n=====\n\nSub\n---\n\nbody',
    'paragraph interrupted without a blank line':
        'para\n# heading\npara\n> quote\nlazy\n\n- a\n- b\ncontinued',
    'loose list across blank lines': '- a\n\n- b\n\n  indented continuation\n\nafter',
    'nested quote and list': '> - a\n>   - b\n>\n> c\n\n> d',
    'indented code after a paragraph': 'text\n\n    code one\n\n    code two\n\ntext',
    'table interrupting a paragraph': 'lead\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntrail',
    'fence with blank lines inside':
        'a\n\n```ts\nconst x = 1;\n\n\nconst y = 2;\n```\n\nb\n\n~~~\nopen',
    'html comment spanning blank lines': 'a\n\n<!-- one\n\ntwo -->\n\nb\n\n<div>\n\n*x*\n\n</div>',
    'reference definition after its use': 'see [docs][d]\n\nmore\n\n[d]: https://example.com/d',
    'tabs and trailing spaces': 'a  \nb\n\n-\tc\n\n\td\n\ne',
    'table header whose delimiter row turns out invalid':
        'p\n| a |\n--x\n\nintro\n| a | b |\n|---|-x\n\n|---|-x\n| b |\n\nend',
    'reference definitions inside a quote and a list':
        '[x][a]\n\nb\n\n> [a]: https://example.com/a\n\n[y][c]\n\n- [c]: https://example.com/c',
    'reference labels with an escaped bracket or a line break':
        '[x][a\\]b]\n\nb\n\n[a\\]b]: https://example.com/u\n\n[y][m n]\n\n[m\nn]: https://example.com/m',
    'CRLF line endings': 'a\r\n\r\n- b\r\n- c\r\n\r\n| a |\r\n| - |\r\n\r\nd',
};

function expectEquivalentWhileStreaming(prefixes: readonly string[], shouldRepair: boolean): void {
    const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
    for (const prefix of prefixes) {
        const source = shouldRepair ? repairStreamingMarkdown(prefix) : prefix;
        expect(parser.parse(source), JSON.stringify(source)).toEqual(
            parseMarkdownBlocks(source, CHAT_OPTIONS),
        );
    }
}

describe('createStreamingMarkdownParser', () => {
    it.each(Object.entries(BOUNDARY_CASES))(
        'matches a full parse at every character of %s',
        (_name, text) => {
            const prefixes = Array.from({ length: text.length }, (_, index) =>
                text.slice(0, index + 1),
            );
            expectEquivalentWhileStreaming(prefixes, false);
            expectEquivalentWhileStreaming(prefixes, true);
        },
    );

    it('matches a full parse at every delta of a long Agent reply', () => {
        const prefixes = streamingPrefixes(agentReplyFixture(4));
        expectEquivalentWhileStreaming(prefixes, false);
        expectEquivalentWhileStreaming(prefixes, true);
    });

    it('matches a full parse when the source is edited, shortened, or loses a definition', () => {
        const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
        for (const source of [
            'a\n\nb\n\nc\n\nd',
            'a\n\nB changed\n\nc\n\nd',
            'a\n\nb',
            'a\r\n\r\n- b\r\n- c',
            'a\n\nb\n\nc\n\nd',
            '[x][a]\n\nb\n\n[a]: https://example.com/a',
            '[x][a]\n\nb\n\nc',
            '',
        ]) {
            expect(parser.parse(source)).toEqual(parseMarkdownBlocks(source, CHAT_OPTIONS));
        }
    });

    /**
     * CI performance gate. Parse work is counted in characters handed to markdown-it, so the budget holds on any
     * machine and fails deterministically when streaming regresses to a full re-parse per delta (about 250x on this
     * fixture).
     */
    it('keeps parse work a small multiple of the reply length', () => {
        const text = agentReplyFixture(12);
        const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
        for (const prefix of streamingPrefixes(text)) parser.parse(repairStreamingMarkdown(prefix));
        parser.parse(text);
        expect(parser.stats().parsedCharacters / text.length).toBeLessThan(10);
    });

    it('keeps the parse-work budget for a reply with CRLF line endings', () => {
        const text = agentReplyFixture(12).replaceAll('\n', '\r\n');
        const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
        for (const prefix of streamingPrefixes(text)) parser.parse(repairStreamingMarkdown(prefix));
        expect(parser.stats().parsedCharacters / text.length).toBeLessThan(10);
    });

    /**
     * CI performance gate. A memoized block renderer skips a reused block on a reference check; only the constructs
     * that can still change (the last two) may be new objects.
     */
    it('keeps settled blocks as the same objects across deltas', () => {
        const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
        let previous = parser.parse('');
        const prefixes = streamingPrefixes(agentReplyFixture(4));
        for (const prefix of prefixes) {
            const blocks = parser.parse(repairStreamingMarkdown(prefix));
            const reused = previous.findIndex((block, index) => blocks[index] !== block);
            const settled = reused === -1 ? previous.length : reused;
            expect(settled, JSON.stringify(prefix.slice(-40))).toBeGreaterThanOrEqual(
                previous.length - 2,
            );
            previous = blocks;
        }
    });

    it('answers an unchanged source without parsing again', () => {
        const parser = createStreamingMarkdownParser(CHAT_OPTIONS);
        const first = parser.parse('a\n\nb');
        expect(parser.parse('a\n\nb')).toBe(first);
        expect(parser.stats().parses).toBe(1);
    });
});
