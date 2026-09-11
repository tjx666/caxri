import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { readDelegationCompletion } from '../collection';
import { applyDelegationLifecycle } from '../lifecycle';

describe('Grok completion evidence collection', () => {
    it.each([false, true])(
        'collects exact completion after an empty Stop: %s',
        async (emptyStop) => {
            let record = {
                receipt: { provider: 'grok', terminalId: 'synthetic-terminal', status: 'running' },
                launchId: 'synthetic-launch',
                providerSessionId: 'synthetic-session',
                turnId: 'synthetic-turn',
                promptDigest: createHash('sha256').update('Synthetic pointer').digest('hex'),
                responseDigest: createHash('sha256').update('Synthetic answer').digest('hex'),
                responseByteLength: 16,
                responseStopCount: 1,
            } as StoredAgentDelegation;
            const stop = {
                provider: 'grok' as const,
                phase: 'turnFinished' as const,
                terminalId: record.receipt.terminalId!,
                launchId: record.launchId!,
                agentSessionId: record.providerSessionId,
                agentTurnId: record.turnId,
            };
            if (emptyStop) {
                const cleared = applyDelegationLifecycle(record, stop, 'evidence');
                expect(cleared).toMatchObject({ responseStopCount: 2 });
                expect(cleared?.responseDigest).toBeUndefined();
                expect(cleared?.responseByteLength).toBeUndefined();
                record = applyDelegationLifecycle(
                    cleared!,
                    {
                        ...stop,
                        agentResponseDigest: record.responseDigest,
                        agentResponseByteLength: record.responseByteLength,
                    },
                    'evidence',
                )!;
            }
            const row = (method: string, update: Record<string, unknown>) =>
                JSON.stringify({ method, params: { sessionId: record.providerSessionId, update } });
            const end = row('_x.ai/session/update', {
                sessionUpdate: 'turn_completed',
                prompt_id: record.turnId,
                stop_reason: 'end_turn',
            });
            const full = [
                row('session/update', {
                    sessionUpdate: 'user_message_chunk',
                    content: { type: 'text', text: 'Synthetic pointer' },
                }),
                row('session/update', {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Synthetic answer' },
                }),
                ...Array.from({ length: emptyStop ? 3 : 1 }, () =>
                    row('_x.ai/session/update', {
                        sessionUpdate: 'hook_execution',
                        event_name: 'stop',
                        prompt_id: record.turnId,
                        runs: [
                            {
                                name: 'Synthetic hook',
                                status: { status: 'success', elapsed_ms: 1 },
                            },
                        ],
                    }),
                ),
                end,
            ].join('\n');
            const readTranscript = vi.fn(() =>
                Promise.resolve({
                    path: '/synthetic/updates.jsonl',
                    exists: true,
                    content: full,
                    truncated: false,
                }),
            );
            const readNativeTranscript = vi.fn(() => Promise.resolve({ content: '', offset: 100 }));
            const reader = { readTranscript, readNativeTranscript };
            expect((await readDelegationCompletion(record, reader)).completion).toBeUndefined();
            expect(readTranscript).not.toHaveBeenCalled();
            readNativeTranscript.mockResolvedValue({ content: end, offset: 200 });
            expect((await readDelegationCompletion(record, reader)).completion).toMatchObject({
                kind: 'answer',
                text: 'Synthetic answer',
            });
            expect(readTranscript).toHaveBeenCalledOnce();
        },
    );
});
