import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { extractClaudeDelegationAnswer } from '../delegation';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const evidence = {
    sessionId: 'synthetic-session',
    promptDigest: digest('Synthetic task'),
    answerDigest: digest('Synthetic answer'),
};
const prompt = JSON.stringify({
    sessionId: evidence.sessionId,
    type: 'user',
    uuid: 'prompt',
    message: { content: 'Synthetic task' },
});
const assistant = (
    uuid: string,
    parent: string,
    id: string,
    text: string,
    usage?: Record<string, number>,
    isSidechain = false,
) =>
    JSON.stringify({
        sessionId: evidence.sessionId,
        type: 'assistant',
        uuid,
        parentUuid: parent,
        isSidechain,
        message: { id, content: [{ type: 'text', text }], usage },
    });

describe('Claude exact-task usage', () => {
    it.each(['system', 'meta'])('excludes a later API call after a %s continuation', (kind) => {
        const source = [
            prompt,
            assistant('answer', 'prompt', 'api-one', 'Synthetic answer', {
                input_tokens: 10,
                output_tokens: 5,
            }),
            JSON.stringify({
                sessionId: evidence.sessionId,
                type: kind === 'meta' ? 'user' : 'system',
                isMeta: kind === 'meta',
                uuid: 'later-prompt',
                parentUuid: 'answer',
                message: { content: 'Later synthetic continuation' },
            }),
            assistant('later', 'later-prompt', 'api-two', 'Later synthetic answer', {
                input_tokens: 1_000,
                output_tokens: 500,
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)?.usage).toMatchObject({
            inputTokens: 10,
            outputTokens: 5,
        });
    });
    it.each([
        'malformed synthetic record',
        assistant('invalid', 'answer', 'api-one', '', { input_tokens: -1, output_tokens: 5 }),
    ])('keeps the answer but rejects contradictory accounting (%#)', (invalid) => {
        const source = [
            prompt,
            assistant('answer', 'prompt', 'api-one', 'Synthetic answer', {
                input_tokens: 10,
                output_tokens: 5,
            }),
            invalid,
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toEqual({
            text: 'Synthetic answer',
            messageId: 'answer',
        });
    });
    it('deduplicates streaming snapshots and includes all main-thread API messages', () => {
        const source = [
            assistant('old', 'unrelated', 'old-message', 'Old synthetic answer', {
                input_tokens: 999,
                output_tokens: 999,
            }),
            prompt,
            assistant('tool', 'prompt', 'api-one', 'Synthetic progress', {
                input_tokens: 10,
                output_tokens: 3,
                cache_read_input_tokens: 20,
            }),
            assistant(
                'side',
                'tool',
                'child-api',
                'Synthetic child answer',
                { input_tokens: 999, output_tokens: 999 },
                true,
            ),
            assistant('answer', 'tool', 'api-two', 'Synthetic answer', {
                input_tokens: 15,
                output_tokens: 1,
                cache_read_input_tokens: 30,
            }),
            assistant('stream', 'answer', 'api-two', '', {
                input_tokens: 15,
                output_tokens: 7,
                cache_read_input_tokens: 30,
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toEqual({
            text: 'Synthetic answer',
            messageId: 'answer',
            usage: {
                source: 'provider',
                scope: 'main-thread',
                inputTokens: 25,
                outputTokens: 10,
                cacheReadTokens: 50,
            },
        });
    });
    it('preserves the answer but omits accounting if any API message has no reliable counters', () => {
        const source = [
            prompt,
            assistant('tool', 'prompt', 'api-one', 'Synthetic progress'),
            assistant('answer', 'tool', 'api-two', 'Synthetic answer', {
                input_tokens: 10,
                output_tokens: 5,
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)).toEqual({
            text: 'Synthetic answer',
            messageId: 'answer',
        });
    });
    it('does not include a later human task with the same answer', () => {
        const source = [
            prompt,
            assistant('answer', 'prompt', 'api-one', 'Synthetic answer', {
                input_tokens: 10,
                output_tokens: 5,
            }),
            JSON.stringify({
                sessionId: evidence.sessionId,
                type: 'user',
                uuid: 'human',
                parentUuid: 'answer',
                message: { content: 'Another synthetic task' },
            }),
            assistant('later', 'human', 'api-two', 'Synthetic answer', {
                input_tokens: 100,
                output_tokens: 50,
            }),
        ].join('\n');
        expect(extractClaudeDelegationAnswer(source, evidence)?.usage).toMatchObject({
            inputTokens: 10,
            outputTokens: 5,
        });
    });
});
