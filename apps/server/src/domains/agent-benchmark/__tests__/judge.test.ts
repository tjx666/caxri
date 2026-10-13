import { describe, expect, it } from 'vitest';

import { buildJudgePrompt, parseJudgeReply } from '../judge';

describe('buildJudgePrompt', () => {
    it('labels every candidate anonymously in a shuffled order', () => {
        const { prompt, labels } = buildJudgePrompt(
            'Fix the bug',
            [
                { attemptId: 'first', finalText: 'Answer one' },
                { attemptId: 'second', finalText: 'Answer two', diff: '+fixed' },
            ],
            () => 0,
        );

        expect(labels).toEqual(
            new Map([
                ['second', 'A'],
                ['first', 'B'],
            ]),
        );
        expect(prompt).toContain('# Task\n\nFix the bug');
        expect(prompt.indexOf('Answer two')).toBeLessThan(prompt.indexOf('Answer one'));
        expect(prompt).toContain('```diff\n+fixed\n```');
        expect(prompt).toContain('(no file changes)');
    });

    it('clips an oversized answer', () => {
        const { prompt } = buildJudgePrompt('Task', [
            { attemptId: 'only', finalText: 'x'.repeat(9_000) },
        ]);

        expect(prompt).toContain(`${'x'.repeat(8_000)}\n[truncated]`);
        expect(prompt).not.toContain('x'.repeat(8_001));
    });
});

describe('parseJudgeReply', () => {
    it('reads scores wrapped in prose and a code fence', () => {
        const scores = parseJudgeReply(
            'Here you go:\n```json\n{"scores":[{"label":"a","score":"87.6","reason":"Correct"},{"label":"B","score":40}]}\n```',
        );

        expect(scores).toEqual(
            new Map([
                ['A', { score: 88, reason: 'Correct' }],
                ['B', { score: 40, reason: '' }],
            ]),
        );
    });

    it.each([
        ['no JSON', 'I cannot judge this.'],
        ['malformed JSON', '{"scores": [}'],
        ['an out-of-range score', '{"scores":[{"label":"A","score":120}]}'],
        ['no scores', '{"scores":[]}'],
    ])('rejects a reply with %s', (_case, reply) => {
        expect(parseJudgeReply(reply)).toBeUndefined();
    });
});
