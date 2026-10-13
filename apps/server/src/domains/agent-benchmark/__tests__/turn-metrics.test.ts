import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { TurnMetrics } from '../turn-metrics';

function clock(start = 1_000) {
    let now = start;
    return { now: () => now, advance: (milliseconds: number) => (now += milliseconds) };
}

function withUsage(usage: AgentChatSnapshot['usage']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('attempt'), usage };
}

const userMessage: AgentChatPatchOperation = {
    op: 'upsertItem',
    item: { id: 'user', type: 'userMessage', text: 'Prompt' },
};
const answer: AgentChatPatchOperation = {
    op: 'upsertItem',
    item: { id: 'answer', type: 'agentMessage', text: 'Hi', streaming: true },
};
const compacted = (id: string): AgentChatPatchOperation => ({
    op: 'upsertItem',
    item: { id, type: 'notice', kind: 'compacted' },
});

describe('TurnMetrics', () => {
    it('reports nothing for a turn that never started', () => {
        const metrics = new TurnMetrics();
        metrics.observe([answer], withUsage({ totalTokens: 10 }));
        expect(metrics.result()).toEqual({});
    });

    it('times the first model output after the prompt, not the echoed user message', () => {
        const time = clock();
        const metrics = new TurnMetrics(time.now);
        metrics.start();
        time.advance(300);
        metrics.observe([userMessage], emptyAgentChatSnapshot('attempt'));
        time.advance(900);
        metrics.observe([answer], emptyAgentChatSnapshot('attempt'));
        time.advance(5_000);
        metrics.observe([answer], emptyAgentChatSnapshot('attempt'));
        expect(metrics.result()).toEqual({ compactions: 0, timeToFirstTokenMs: 1_200 });
    });

    it('counts each compaction once and keeps the peak context across it', () => {
        const metrics = new TurnMetrics();
        metrics.start();
        metrics.observe(
            [answer],
            withUsage({ totalTokens: 150_000, contextWindow: 1_000_000, compactWindow: 200_000 }),
        );
        metrics.observe([compacted('c1')], withUsage({ totalTokens: 30_000 }));
        // A driver re-upserts the same notice when it settles; that is still one compaction.
        metrics.observe([compacted('c1')], withUsage(undefined));
        metrics.observe(
            [compacted('c2')],
            withUsage({ totalTokens: 40_000, contextWindow: 1_000_000 }),
        );
        expect(metrics.result()).toMatchObject({
            compactions: 2,
            context: { peakTokens: 150_000, finalTokens: 40_000, window: 1_000_000 },
        });
    });
});
