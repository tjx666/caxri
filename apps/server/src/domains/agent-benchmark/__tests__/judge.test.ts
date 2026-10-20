import { describe, expect, it } from 'vitest';

import { buildJudgePrompt, MAX_JUDGE_PROMPT_LENGTH, parseJudgeReply } from '../judge';

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

describe('buildJudgePrompt budget', () => {
    it.each([24, 120, 200])('keeps %i large candidates within the prompt budget', (count) => {
        const candidates = Array.from({ length: count }, (_value, index) => ({
            attemptId: `attempt-${index}`,
            finalText: `answer-${index} ${'a'.repeat(20_000)}`,
            diff: `+diff-${index} ${'d'.repeat(100_000)}`,
        }));

        const { prompt, labels } = buildJudgePrompt('Task', candidates);

        expect(prompt.length).toBeLessThanOrEqual(MAX_JUDGE_PROMPT_LENGTH);
        expect(labels.size).toBe(count);
        // Every candidate keeps its label and some of its answer and diff.
        for (const [index, candidate] of candidates.entries()) {
            expect(prompt).toContain(`answer-${index} `);
            expect(prompt).toContain(`+diff-${index} `);
            expect(labels.has(candidate.attemptId)).toBe(true);
        }
        expect(prompt).toContain('[truncated]');
    });

    it('gives room a short answer leaves unused to its diff', () => {
        const { prompt } = buildJudgePrompt(
            'Task',
            Array.from({ length: 100 }, () => ({
                attemptId: Math.random().toString(),
                finalText: 'ok',
                diff: 'd'.repeat(20_000),
            })),
        );

        expect(prompt.length).toBeLessThanOrEqual(MAX_JUDGE_PROMPT_LENGTH);
        expect(prompt).toContain('d'.repeat(3_500));
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
