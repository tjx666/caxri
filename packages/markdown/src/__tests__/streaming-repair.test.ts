import { describe, expect, it } from 'vitest';

import { createStreamingMarkdownRepair, repairStreamingMarkdown } from '../streaming-repair.js';
import {
    agentListReplyFixture,
    agentReplyFixture,
    streamingPrefixes,
} from './agent-reply.fixture.js';
import { referenceRepair } from './streaming-repair-reference.js';

describe('repairStreamingMarkdown', () => {
    it.each([
        ['Hello **wor', 'Hello **wor**'],
        ['a *it', 'a *it*'],
        ['x `co', 'x `co`'],
        ['~~gone', '~~gone~~'],
        ['para\n\n**bold *it', 'para\n\n**bold *it***'],
        ['done.\n\n`a` and **b', 'done.\n\n`a` and **b**'],
    ])('closes the open span in %j', (source, expected) => {
        expect(repairStreamingMarkdown(source)).toBe(expected);
    });

    it.each([
        ['Hello **', 'Hello '],
        ['see [docs](https://exa', 'see docs'],
        ['see [doc', 'see doc'],
        ['Para\n-', 'Para\n'],
    ])('holds back the unfinished syntax in %j', (source, expected) => {
        expect(repairStreamingMarkdown(source)).toBe(expected);
    });

    it.each(['**bold**', '2 * 3', '- [ ] task', 'snake_case_name', '```ts\nconst **a'])(
        'leaves %j unchanged',
        (source) => {
            expect(repairStreamingMarkdown(source)).toBe(source);
        },
    );

    it('treats a fence line with an info string as content, not a closer', () => {
        const source = '```md\n```ts\n**a';
        expect(repairStreamingMarkdown(source)).toBe(source);
    });

    it('only repairs the last block', () => {
        expect(repairStreamingMarkdown('**not closed\n\nnext *open')).toBe(
            '**not closed\n\nnext *open*',
        );
    });
});

/**
 * Line shapes that exercise every rule the repair carries across lines: open code spans (including runs and spans over
 * a newline), emphasis on list bullets, fences, links, setext underlines, blank lines, and CRLF.
 */
const FUZZ_PIECES = [
    'para',
    '**bold',
    '*it',
    '~~gone',
    '`co',
    '``x``',
    'a`b`c',
    '* bullet',
    '  * nested **b',
    '- item *x',
    '1. one `tick',
    '```ts',
    '~~~',
    '```',
    '',
    ' '.repeat(3),
    '-',
    '=',
    '[docs](https://exa',
    '[lab',
    '![img](x',
    'end **',
    ' ~~',
    '`',
    '*',
    '**',
    'x\r',
    '\u{2028}* y',
    'tail * star',
];

function seeded(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
        return state / 0x7f_ff_ff_ff;
    };
}

function expectReferenceAtEveryPrefix(text: string): void {
    const repair = createStreamingMarkdownRepair();
    for (let end = 0; end <= text.length; end += 1) {
        const prefix = text.slice(0, end);
        expect(repair.repair(prefix), JSON.stringify(prefix)).toBe(referenceRepair(prefix));
    }
}

describe('createStreamingMarkdownRepair', () => {
    it.each([
        ['a long Agent reply', agentReplyFixture(3)],
        ['a reply that is one long list', agentListReplyFixture(30)],
        ['a reply with CRLF line endings', agentReplyFixture(2).replaceAll('\n', '\r\n')],
        ['a code span over a newline then a bullet', 'x\n`ab\ncd` * y\n* z **w\n\n`q\n\nr *s'],
    ])('matches the full rescan at every character of %s', (_name, text) => {
        expectReferenceAtEveryPrefix(text);
    });

    it('matches the full rescan for seeded random documents', () => {
        const random = seeded(1666);
        for (let document = 0; document < 400; document += 1) {
            const text = Array.from(
                { length: 2 + Math.floor(random() * 10) },
                () => FUZZ_PIECES[Math.floor(random() * FUZZ_PIECES.length)]!,
            ).join(random() < 0.2 ? '\r\n' : '\n');
            expectReferenceAtEveryPrefix(text);
        }
    });

    it('starts over when the source is edited or shortened', () => {
        const repair = createStreamingMarkdownRepair();
        for (const source of [
            '- a **b\n- c',
            '- a **b\n- c *d',
            '- a\n- c *d',
            '```\n**x',
            '- a **b\n',
            '',
            'p `x',
        ])
            expect(repair.repair(source)).toBe(referenceRepair(source));
    });

    /**
     * CI performance gate. Repair work is counted in source characters scanned, so the budget holds on any machine and
     * fails deterministically when the repair regresses to rescanning the reply (or its last block) on every delta.
     */
    it.each([
        ['a long Agent reply', agentReplyFixture(12)],
        ['a reply that is one long list', agentListReplyFixture(200)],
    ])('keeps repair work a small multiple of the length of %s', (_name, text) => {
        const repair = createStreamingMarkdownRepair();
        for (const prefix of streamingPrefixes(text)) repair.repair(prefix);
        expect(repair.stats().scannedCharacters / text.length).toBeLessThan(10);
    });
});
