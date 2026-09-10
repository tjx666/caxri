import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { readDelegationCompletion } from '../collection';

describe('Grok completion evidence collection', () => {
    it('reads earlier response chunks only after an incremental exact completion arrives', async () => {
        const record = {
            receipt: { provider: 'grok', terminalId: 'synthetic-terminal' },
            providerSessionId: 'synthetic-session',
            turnId: 'synthetic-turn',
            promptDigest: createHash('sha256').update('Synthetic pointer').digest('hex'),
            responseDigest: createHash('sha256').update('Synthetic answer').digest('hex'),
            responseByteLength: 16,
            responseStopCount: 1,
        } as StoredAgentDelegation;
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
            row('_x.ai/session/update', {
                sessionUpdate: 'hook_execution',
                event_name: 'stop',
                prompt_id: record.turnId,
                runs: [{ name: 'Synthetic hook', status: { status: 'success', elapsed_ms: 1 } }],
            }),
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
    });
});
