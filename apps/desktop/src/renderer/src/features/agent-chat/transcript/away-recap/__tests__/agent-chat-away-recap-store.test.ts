import type { AgentChatSnapshot } from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    useAgentChatAwayRecapStore,
    visibleAgentChatAwayRecap,
} from '../agent-chat-away-recap-store';

const recap = {
    text: 'Tests pass; merge the pull request next.',
    lastResponseAt: 100,
    generatedAt: 200,
};

function snapshot(overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot {
    return {
        awayRecap: recap,
        usage: { lastResponseAt: 100 },
        ...overrides,
    } as AgentChatSnapshot;
}

describe('visibleAgentChatAwayRecap', () => {
    beforeEach(() => useAgentChatAwayRecapStore.setState({ dismissed: {} }));

    it('shows the recap of the latest reply', () => {
        expect(visibleAgentChatAwayRecap(snapshot(), undefined)).toEqual(recap);
    });

    it('hides it once the Chat replies again or starts a turn', () => {
        expect(
            visibleAgentChatAwayRecap(
                snapshot({ usage: { lastResponseAt: 300 } } as Partial<AgentChatSnapshot>),
                undefined,
            ),
        ).toBeUndefined();
        expect(
            visibleAgentChatAwayRecap(snapshot({ activeTurnId: 'turn-2' }), undefined),
        ).toBeUndefined();
    });

    it('hides only the recap the user closed, so the next one shows again', () => {
        useAgentChatAwayRecapStore.getState().dismiss('terminal-1', 200);
        const dismissedAt = useAgentChatAwayRecapStore.getState().dismissed['terminal-1'];
        expect(visibleAgentChatAwayRecap(snapshot(), dismissedAt)).toBeUndefined();
        const next = { ...recap, lastResponseAt: 300, generatedAt: 400 };
        expect(
            visibleAgentChatAwayRecap(
                snapshot({
                    awayRecap: next,
                    usage: { lastResponseAt: 300 },
                } as Partial<AgentChatSnapshot>),
                dismissedAt,
            ),
        ).toEqual(next);
    });
});
