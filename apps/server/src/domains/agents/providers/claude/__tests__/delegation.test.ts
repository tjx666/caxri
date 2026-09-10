import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { extractClaudeDelegationAnswer } from '../delegation';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const evidence = {
    sessionId: 'synthetic-session',
    promptDigest: digest('Synthetic task'),
    answerDigest: digest('Synthetic final answer'),
};

function record(type: string, uuid: string, parentUuid: string | null, text: string, extra = {}) {
    return JSON.stringify({
        sessionId: evidence.sessionId,
        type,
        uuid,
        parentUuid,
        message: { content: [{ type: 'text', text }] },
        ...extra,
    });
}

const prompt = record('user', 'prompt', null, 'Synthetic task');
const intermediate = record('assistant', 'intermediate', 'prompt', 'Synthetic progress');
const final = record('assistant', 'final', 'intermediate', 'Synthetic final answer');

describe('extractClaudeDelegationAnswer', () => {
    it('joins text blocks with one native message identity across transcript records', () => {
        const source = [
            prompt,
            record('assistant', 'thinking', 'prompt', '', {
                message: {
                    id: 'native-message',
                    content: [{ type: 'thinking', thinking: 'Synthetic reasoning' }],
                },
            }),
            record('assistant', 'part-one', 'thinking', '', {
                message: {
                    id: 'native-message',
                    content: [{ type: 'text', text: 'Synthetic final' }],
                },
            }),
            record('assistant', 'part-two', 'part-one', '', {
                message: { id: 'native-message', content: [{ type: 'text', text: ' answer' }] },
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toEqual({
            text: 'Synthetic final answer',
            messageId: 'part-two',
        });
    });

    it('follows native attachment and system records between the prompt and answer', () => {
        const source = [
            prompt,
            record('attachment', 'attachment', 'prompt', '', { message: undefined }),
            record('system', 'system', 'attachment', '', { message: undefined }),
            record('assistant', 'answer', 'system', 'Synthetic final answer'),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toEqual({
            text: 'Synthetic final answer',
            messageId: 'answer',
        });
    });

    it('rejects human input containing an image alongside text', () => {
        const source = [
            prompt,
            record('user', 'human', 'prompt', '', {
                message: { content: [{ type: 'text', text: 'New question' }, { type: 'image' }] },
            }),
            record('assistant', 'answer', 'human', 'Synthetic final answer'),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toBeUndefined();
    });

    it('waits for the exact final response when the transcript lags Stop', () => {
        expect(
            extractClaudeDelegationAnswer([prompt, intermediate].join('\n'), evidence),
        ).toBeUndefined();
        expect(
            extractClaudeDelegationAnswer([prompt, intermediate, final].join('\n'), evidence),
        ).toEqual({ text: 'Synthetic final answer', messageId: 'final' });
    });

    it('does not match an old response, unrelated branch, or subagent', () => {
        const source = [
            record('assistant', 'old', null, 'Synthetic final answer'),
            prompt,
            record('assistant', 'side', 'prompt', 'Synthetic final answer', { isSidechain: true }),
            record('assistant', 'other', 'unrelated-prompt', 'Synthetic final answer'),
            record('assistant', 'wrong-session', 'prompt', 'Synthetic final answer', {
                sessionId: 'other-session',
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toBeUndefined();
    });

    it('rejects answers after another human prompt, including repeated task text', () => {
        const source = [
            prompt,
            intermediate,
            record('user', 'human', 'intermediate', 'Synthetic task'),
            record('assistant', 'human-answer', 'human', 'Synthetic final answer'),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toBeUndefined();
    });

    it('follows tool-result ancestry without treating tool output as a human prompt', () => {
        const tool = record('user', 'tool', 'intermediate', '', {
            message: {
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool',
                        content: 'Synthetic tool result',
                    },
                ],
            },
        });
        const source = [
            prompt,
            intermediate,
            tool,
            record('assistant', 'answer', 'tool', 'Synthetic final answer'),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)?.messageId).toBe('answer');
    });

    it('does not accept a matching answer without the exact task prompt', () => {
        expect(
            extractClaudeDelegationAnswer([intermediate, final].join('\n'), evidence),
        ).toBeUndefined();
        expect(
            extractClaudeDelegationAnswer(
                [record('user', 'prompt', null, 'Different task'), intermediate, final].join('\n'),
                evidence,
            ),
        ).toBeUndefined();
    });

    it('ignores a partial record until it is fully written', () => {
        expect(
            extractClaudeDelegationAnswer(
                [prompt, intermediate, final.slice(0, -4)].join('\n'),
                evidence,
            ),
        ).toBeUndefined();
    });
});
