import { describe, expect, it } from 'vitest';

import { withAgentChatAwayRecap } from '../agent-chat-away-recap-entry';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';

describe('withAgentChatAwayRecap', () => {
    const reply: AgentChatTimelineEntry = {
        kind: 'message',
        id: 'a1',
        message: { id: 'a1', type: 'agentMessage', text: 'Done.' },
    };
    const recap = { text: 'Shipped the fix.', lastResponseAt: 100, generatedAt: 200 };
    const snapshot = { activeTurnId: undefined, awayRecap: recap, usage: { lastResponseAt: 100 } };

    it('adds the current recap after the last reply', () => {
        const entries = withAgentChatAwayRecap([reply], snapshot as never, undefined);
        expect(entries.at(-1)).toEqual({
            kind: 'awayRecap',
            id: 'away-recap',
            generatedAt: 200,
            text: 'Shipped the fix.',
        });
    });

    it('leaves out a recap the user closed, but not the next one', () => {
        expect(withAgentChatAwayRecap([reply], snapshot as never, 200)).toEqual([reply]);
        expect(withAgentChatAwayRecap([reply], snapshot as never, 150)).toHaveLength(2);
    });

    it('drops the recap once a turn runs or a newer reply landed', () => {
        const running = { ...snapshot, activeTurnId: 't2' };
        expect(withAgentChatAwayRecap([reply], running as never, undefined)).toEqual([reply]);
        const replied = { ...snapshot, usage: { lastResponseAt: 300 } };
        expect(withAgentChatAwayRecap([reply], replied as never, undefined)).toEqual([reply]);
    });

    it('shows nothing without a recap', () => {
        expect(withAgentChatAwayRecap([reply], undefined, undefined)).toEqual([reply]);
    });

    it('leaves with a message still on its way', () => {
        const pending: AgentChatTimelineEntry = {
            kind: 'pending',
            id: 'p1',
            text: 'next',
            imageUris: [],
        };
        expect(withAgentChatAwayRecap([reply, pending], snapshot as never, undefined)).toEqual([
            reply,
            pending,
        ]);
    });
});
