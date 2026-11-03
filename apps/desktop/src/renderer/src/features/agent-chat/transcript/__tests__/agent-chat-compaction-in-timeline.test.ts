import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import { agentChatCompactionInTimeline } from '../agent-chat-timeline';

const prompt: AgentChatTimelineEntry = {
    kind: 'item',
    item: { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Ready to merge?' },
};
const answer: AgentChatTimelineEntry = {
    kind: 'item',
    item: { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Yes', streaming: false },
};

describe('agentChatCompactionInTimeline', () => {
    it('shows nothing while no compaction runs', () => {
        expect(agentChatCompactionInTimeline({}, [prompt])).toBeUndefined();
        expect(agentChatCompactionInTimeline(undefined, [prompt])).toBeUndefined();
    });

    it('carries when it started, and whether an unanswered message waits on it', () => {
        expect(
            agentChatCompactionInTimeline({ operation: 'compacting', operationStartedAt: 1000 }, [
                prompt,
            ]),
        ).toEqual({ startedAt: 1000, isAfterUserMessage: true });
        expect(
            agentChatCompactionInTimeline({ operation: 'compacting' }, [prompt, answer]),
        ).toEqual({ startedAt: undefined, isAfterUserMessage: false });
    });

    it('does not read the /compact the user sent as a message waiting on the compaction', () => {
        const compact: AgentChatTimelineEntry = {
            kind: 'item',
            item: { id: 'u2', turnId: 't2', type: 'userMessage', text: '/compact keep the plan' },
        };
        expect(agentChatCompactionInTimeline({ operation: 'compacting' }, [compact])).toEqual({
            startedAt: undefined,
            isAfterUserMessage: false,
        });
    });
});
