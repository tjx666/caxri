import { describe, expect, it } from 'vitest';

import {
    harness,
    recordsChanged,
    session,
} from '../../__tests__/support/agent-notification-harness';

describe('Agent notification coordinator while Caxri is focused', () => {
    it('suppresses a background Session banner while a Caxri window is focused', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        test.select('session-2');
        test.setVisible(true);
        test.setAppFocused(true);
        test.setSession(
            session({
                id: 'session-1',
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                sessionActivityAt: 2_000,
                sessionActivityReason: 'agent_waiting',
            }),
        );

        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toEqual([]);

        // Leaving Caxri does not replay the epoch the sidebar already showed; the next attention notifies again.
        test.setAppFocused(false);
        test.setSession(
            session({
                id: 'session-1',
                attentionGeneration: 2,
                hasUnread: true,
                agentActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                sessionActivityAt: 3_000,
                sessionActivityReason: 'agent_waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(1);
    });
});
