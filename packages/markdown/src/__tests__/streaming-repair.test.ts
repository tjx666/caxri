import { describe, expect, it } from 'vitest';

import { repairStreamingMarkdown } from '../streaming-repair.js';

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
