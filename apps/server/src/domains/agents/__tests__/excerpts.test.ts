import type { AgentChatRequest, AgentTimelineItem } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { readAgentExcerpts } from '../excerpts';
import type { AgentTimelineService } from '../timeline';

const reply: AgentTimelineItem[] = [
    { id: 'u', type: 'userMessage', text: 'go' },
    { id: 'a', type: 'agentMessage', text: 'All **done**.' },
];

function sources(options: { request?: AgentChatRequest; items?: AgentTimelineItem[] } = {}) {
    const sessions: Record<
        string,
        { primaryAgentTerminalId?: string; attentionGeneration: number }
    > = {
        asked: { primaryAgentTerminalId: 't-asked', attentionGeneration: 4 },
        bare: { attentionGeneration: 1 },
    };
    const read = vi.fn(() =>
        Promise.resolve({ status: 'available', items: options.items ?? reply }),
    );
    const pendingRequest = vi.fn(() => options.request);
    return {
        read,
        pendingRequest,
        sources: {
            database: { getSession: (id: string) => sessions[id] } as unknown as CaxriDatabase,
            timeline: { read } as unknown as AgentTimelineService,
            pendingRequest,
        },
    };
}

describe('readAgentExcerpts', () => {
    it('shows the question a live Chat is waiting on without reading the transcript', async () => {
        const { read, sources: wired } = sources({
            request: {
                id: 'r',
                kind: 'question',
                questions: [
                    {
                        id: 'q',
                        header: 'h',
                        question: 'Which **database** should I use?',
                        options: [],
                        allowsOther: true,
                    },
                ],
            },
        });
        await expect(
            readAgentExcerpts(wired, [{ sessionId: 'asked', attentionGeneration: 4 }]),
        ).resolves.toEqual({
            asked: { kind: 'request', text: 'Which database should I use?' },
        });
        expect(read).not.toHaveBeenCalled();
    });

    it('falls back to the last reply from the transcript', async () => {
        const { sources: wired } = sources();
        await expect(
            readAgentExcerpts(wired, [{ sessionId: 'asked', attentionGeneration: 4 }]),
        ).resolves.toEqual({ asked: { kind: 'reply', text: 'All done.' } });
    });

    it('omits a stale generation, a Session without an Agent, and an unknown Session', async () => {
        const { read, sources: wired } = sources();
        await expect(
            readAgentExcerpts(wired, [
                { sessionId: 'asked', attentionGeneration: 3 },
                { sessionId: 'bare', attentionGeneration: 1 },
                { sessionId: 'missing', attentionGeneration: 0 },
            ]),
        ).resolves.toEqual({});
        expect(read).not.toHaveBeenCalled();
    });
});
