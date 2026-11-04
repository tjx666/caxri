import type { MobileServerPayload } from '@caxri/mobile-transport';
// oxlint-disable typescript/require-await -- Async Host and authorization fakes preserve the production Promise boundary.
import type { Principal } from '@caxri/protocol';
import { expect, it, vi } from 'vitest';

import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

/**
 * Mobile has no question surface (see `docs/agent-delegation.md`): the question event is not part of any paired-device
 * resource, so it reaches no phone even though the Desktop windows receive it.
 */
it('does not forward a delegated Session question event to a paired device', async () => {
    const sent: MobileServerPayload[] = [];
    const subscriptions = new MobileGatewaySubscriptions({
        authorize: async () => {},
        currentPrincipal: () => principal,
        matches: async () => true,
        randomId: () => 'dashboard-subscription',
        send: async (payload) => {
            sent.push(payload);
        },
        terminate: vi.fn(),
        connectionId: 'connection-1',
    });
    const id = await subscriptions.subscribe({ kind: 'dashboard' });
    subscriptions.activate(id);

    subscriptions.publish({
        event: 'agent.delegation.questionChanged',
        payload: {
            sessionId: 'session-1',
            delegationId: 'task-1',
            questionId: 'question-1',
            state: 'open',
            escalated: false,
        },
    });
    // A control event proves the subscription delivers, so the silence above is the filter and not a dead socket.
    subscriptions.publish({ event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } });

    await vi.waitFor(() =>
        expect(sent).toEqual([
            { type: 'event', subscriptionId: id, sequence: 0, kind: 'dashboard.changed' },
        ]),
    );
    subscriptions.close();
});
