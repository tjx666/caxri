import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:fixture',
    deviceId: 'fixture',
    generation: 1,
    role: 'view',
    projectIds: ['project-fixture'],
};

describe('mobile Conversation subscription', () => {
    it('activates the Server watch only for a subscriber and releases it on unsubscribe', async () => {
        const close = vi.fn();
        const beginConversation = vi.fn(() => Promise.resolve(close));
        const send = vi.fn(() => Promise.resolve());
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            beginConversation,
            connectionId: 'connection-fixture',
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => 'subscription-fixture',
            send,
            terminate: vi.fn(),
        });
        const id = await subscriptions.subscribe({
            kind: 'conversation',
            sessionId: 'session-fixture',
        });
        expect(beginConversation).toHaveBeenCalledWith(principal, 'session-fixture');
        subscriptions.publish({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-fixture' },
        });
        expect(send).not.toHaveBeenCalled();
        // The change before activation arrives as one re-read hint once the phone holds the subscription.
        subscriptions.activate(id);
        await vi.waitFor(() =>
            expect(send).toHaveBeenCalledWith({
                type: 'event',
                subscriptionId: id,
                sequence: 0,
                kind: 'conversation.changed',
            }),
        );
        subscriptions.publish({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-fixture' },
        });
        await vi.waitFor(() =>
            expect(send).toHaveBeenCalledWith({
                type: 'event',
                subscriptionId: id,
                sequence: 1,
                kind: 'conversation.changed',
            }),
        );
        subscriptions.unsubscribe(id);
        expect(close).toHaveBeenCalledOnce();
        subscriptions.publish({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-fixture' },
        });
        expect(send).toHaveBeenCalledTimes(2);
        subscriptions.close();
        expect(close).toHaveBeenCalledOnce();
    });

    it('holds an Agent Chat watch for the subscription and releases it once', async () => {
        const close = vi.fn();
        const beginAgentChat = vi.fn(() => Promise.resolve(close));
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => Promise.resolve(),
            beginAgentChat,
            connectionId: 'connection-fixture',
            currentPrincipal: () => principal,
            matches: () => Promise.resolve(true),
            randomId: () => 'subscription-fixture',
            send: vi.fn(() => Promise.resolve()),
            terminate: vi.fn(),
        });
        const id = await subscriptions.subscribe({
            kind: 'agentChat',
            terminalId: 'terminal-fixture',
        });
        expect(beginAgentChat).toHaveBeenCalledWith(principal, 'terminal-fixture');
        subscriptions.unsubscribe(id);
        subscriptions.close();
        expect(close).toHaveBeenCalledOnce();
    });
});
