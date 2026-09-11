import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { extractGrokDelegationCompletion, grokDelegationAdapter } from '../delegation';

const evidence = {
    sessionId: 'synthetic-session',
    turnId: 'synthetic-prompt',
    promptDigest: createHash('sha256').update('Synthetic pointer').digest('hex'),
    answerDigest: createHash('sha256').update('Synthetic answer').digest('hex'),
    answerByteLength: 16,
    answerStopCount: 1,
};
const marker = (update: Record<string, unknown> = {}, sessionId = evidence.sessionId) =>
    JSON.stringify({
        method: '_x.ai/session/update',
        params: {
            sessionId,
            update: {
                sessionUpdate: 'turn_completed',
                prompt_id: evidence.turnId,
                stop_reason: 'end_turn',
                ...update,
            },
        },
    });
const chunk = (sessionUpdate: string, text: string, sessionId = evidence.sessionId) =>
    JSON.stringify({
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } },
    });
const stopGate = (isBlocked = false) =>
    JSON.stringify({
        method: '_x.ai/session/update',
        params: {
            sessionId: evidence.sessionId,
            update: {
                sessionUpdate: 'hook_execution',
                event_name: 'stop',
                prompt_id: evidence.turnId,
                runs: [
                    {
                        name: 'Synthetic hook',
                        status: isBlocked
                            ? { status: 'failed', blocked: true }
                            : { status: 'success', elapsed_ms: 1 },
                    },
                ],
            },
        },
    });
const completion = (update: Record<string, unknown> = {}) =>
    [
        chunk('user_message_chunk', 'Synthetic pointer'),
        chunk('agent_message_chunk', 'Synthetic answer'),
        stopGate(),
        marker(update),
    ].join('\n');

describe('Grok exact delegation completion', () => {
    it('excludes prior responses in tool and Stop-hook continuation loops', () => {
        const source = [
            chunk('user_message_chunk', 'Synthetic pointer'),
            chunk('agent_message_chunk', 'Intermediate explanation'),
            stopGate(true),
            chunk('agent_message_chunk', 'Final '),
            chunk('agent_message_chunk', 'answer'),
            stopGate(),
            marker(),
            chunk('agent_message_chunk', 'Later text'),
        ].join('\n');
        expect(
            extractGrokDelegationCompletion(source, {
                ...evidence,
                answerDigest: createHash('sha256').update('Final answer').digest('hex'),
                answerByteLength: 12,
                answerStopCount: 2,
            }),
        ).toMatchObject({
            kind: 'answer',
            text: 'Final answer',
        });
    });
    it.each([[chunk('user_message_chunk', 'Unrelated prompt')], ['{malformed']])(
        'rejects an unproven boundary inside the task (%#)',
        (...interruption) => {
            const source = [
                chunk('user_message_chunk', 'Synthetic pointer'),
                ...interruption,
                chunk('agent_message_chunk', 'Incorrect answer'),
                stopGate(),
                marker(),
            ].join('\n');
            expect(extractGrokDelegationCompletion(source, evidence)).toMatchObject({
                kind: 'failed',
                failure: 'correlation_missing',
            });
        },
    );
    it('does not reuse the preceding response when the final response has no text', () => {
        const source = [
            chunk('user_message_chunk', 'Synthetic pointer'),
            chunk('agent_message_chunk', 'Old answer'),
            stopGate(),
            marker(),
        ].join('\n');
        expect(
            extractGrokDelegationCompletion(source, { ...evidence, answerByteLength: 0 }),
        ).toMatchObject({
            kind: 'failed',
            failure: 'result_missing',
        });
    });
    it('reads a successful native answer from ACP text before its completion marker', () => {
        const prompt = 'Synthetic pointer';
        const event = (sessionUpdate: string, text: string) =>
            JSON.stringify({
                method: 'session/update',
                params: {
                    sessionId: evidence.sessionId,
                    update: { sessionUpdate, content: { type: 'text', text } },
                },
            });
        const source = [
            event('user_message_chunk', prompt),
            event('agent_message_chunk', 'Synthetic answer'),
            stopGate(),
            marker(),
        ].join('\n');
        expect(
            extractGrokDelegationCompletion(source, {
                ...evidence,
                promptDigest: createHash('sha256').update(prompt).digest('hex'),
            }),
        ).toMatchObject({ kind: 'answer', text: 'Synthetic answer' });
    });
    it('recognizes the native rate_limit stop reason without an error kind', () => {
        expect(
            extractGrokDelegationCompletion(
                completion({ stop_reason: 'rate_limit', agent_result: undefined }),
                evidence,
            ),
        ).toMatchObject({ kind: 'failed', failure: 'rate_limited' });
    });
    it('uses only the exact native session and prompt completion with provider-task usage', () => {
        const source = [
            marker({}, 'other-session'),
            marker({ prompt_id: 'other-prompt' }),
            completion({ usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 } }),
        ].join('\n');
        expect(extractGrokDelegationCompletion(source, evidence)).toEqual({
            kind: 'answer',
            text: 'Synthetic answer',
            messageId: evidence.turnId,
            usage: {
                source: 'provider',
                scope: 'provider-task',
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 3,
            },
        });
    });
    it('rejects conflicting completion evidence rather than choosing the latest answer', () => {
        expect(
            extractGrokDelegationCompletion([completion(), completion()].join('\n'), evidence),
        ).toEqual({ kind: 'failed', failure: 'correlation_missing' });
    });
    it.each([
        { usageIsIncomplete: true, inputTokens: 10, outputTokens: 5 },
        { inputTokens: -1, outputTokens: 5 },
        {},
    ])('keeps the answer with unknown usage for incomplete accounting (%#)', (usage) => {
        expect(extractGrokDelegationCompletion(completion({ usage }), evidence)).toMatchObject({
            kind: 'answer',
            text: 'Synthetic answer',
            usage: undefined,
        });
    });
    it.each([
        ['auth', 'authentication_failed'],
        ['rate_limited', 'rate_limited'],
        ['max_tokens_truncation', 'output_limit'],
    ])('classifies native %s without returning diagnostic text', (error, failure) => {
        expect(
            extractGrokDelegationCompletion(
                completion({ error_kind: error, agent_result: 'Private error' }),
                evidence,
            ),
        ).toMatchObject({ kind: 'failed', failure });
    });
    it('never substitutes an intermediate message for a missing final result', () => {
        expect(
            extractGrokDelegationCompletion([stopGate(), marker()].join('\n'), evidence),
        ).toMatchObject({
            kind: 'failed',
            failure: 'result_missing',
        });
        expect(
            extractGrokDelegationCompletion(
                completion({ sessionUpdate: 'agent_message_chunk' }),
                evidence,
            ),
        ).toBeUndefined();
    });
    it('fails closed when native Stop text was clipped', () => {
        expect(
            extractGrokDelegationCompletion(completion(), { ...evidence, answerOverflow: true }),
        ).toMatchObject({ kind: 'failed', failure: 'payload_overflow' });
    });
    it.each([true, false])(
        'rejects stale Stop proof after a forced or undelivered final gate (%s)',
        (blocked) => {
            const source = [
                chunk('agent_message_chunk', 'A longer answer ending with Synthetic answer'),
                stopGate(blocked),
                marker(),
            ].join('\n');
            expect(
                extractGrokDelegationCompletion(source, {
                    ...evidence,
                    answerStopCount: blocked ? 1 : 0,
                }),
            ).toMatchObject({ kind: 'failed', failure: 'correlation_missing' });
        },
    );
    it('keeps session identity and the private pointer owned by the task', () => {
        expect(grokDelegationAdapter.freshLaunch).toBeUndefined();
        expect(grokDelegationAdapter.resumeLaunch).toBeUndefined();
        for (const arguments_ of [
            ['--resume', 'other'],
            ['--session-id', 'other'],
            ['--prompt-file', '/other'],
            ['agent'],
            ['--system-prompt-override', 'other'],
        ])
            expect(() =>
                grokDelegationAdapter.validateLaunch({ executable: 'grok', args: arguments_ }),
            ).toThrow();
    });
});
