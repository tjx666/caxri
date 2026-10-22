import type { AgentChatSnapshot } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
const tryCommand = vi.fn<(label: string, run: () => Promise<unknown>) => Promise<unknown>>();
const cache: { snapshot?: AgentChatSnapshot } = {};

vi.mock('../../../stores/toasts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    tryCommand: (label: string, run: () => Promise<unknown>) => tryCommand(label, run),
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));
vi.mock('../agent-chat-client', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    cachedAgentChatSnapshot: () => cache.snapshot,
}));

const { sendAgentChatQueuedNow } = await import('../agent-chat-commands');
const { selectAgentChatPendingMessages, useAgentChatPendingStore } =
    await import('../transcript/agent-chat-pending');

function pendingTexts(): string[] {
    return selectAgentChatPendingMessages('t1')(useAgentChatPendingStore.getState()).map(
        (message) => `${message.placement}:${message.text}`,
    );
}

function snapshot(overrides: Partial<AgentChatSnapshot>): AgentChatSnapshot {
    return {
        terminalId: 't1',
        revision: 1,
        status: 'ready',
        items: [],
        turns: [],
        requests: [],
        tasks: [],
        queue: [
            { id: 'q1', text: 'Steer me' },
            { id: 'q2', text: '', command: { name: 'review' } },
        ],
        ...overrides,
    } as AgentChatSnapshot;
}

describe('sendAgentChatQueuedNow', () => {
    beforeEach(() => {
        request.mockReset();
        tryCommand.mockReset();
        useAgentChatPendingStore.setState({ messages: {}, answers: {} });
    });

    it('shows a message steered out of the queue at the end of the timeline until the turn records it', async () => {
        cache.snapshot = snapshot({ activeTurnId: 'turn-1', operation: 'compacting' });
        tryCommand.mockImplementation(async (_label, run) => run());
        sendAgentChatQueuedNow('t1', 'q1');
        expect(pendingTexts()).toEqual(['timeline:Steer me']);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        expect(pendingTexts()).toEqual(['timeline:Steer me']);
    });

    it('drops the pending row when the steer is refused, since the message returns to the queue', async () => {
        cache.snapshot = snapshot({ activeTurnId: 'turn-1' });
        tryCommand.mockResolvedValue(undefined);
        sendAgentChatQueuedNow('t1', 'q1');
        await vi.waitFor(() => expect(pendingTexts()).toEqual([]));
    });

    it('adds no pending row for a queued command or an idle Chat', () => {
        tryCommand.mockReturnValue(new Promise(() => {}));
        cache.snapshot = snapshot({ activeTurnId: 'turn-1' });
        sendAgentChatQueuedNow('t1', 'q2');
        cache.snapshot = snapshot({});
        sendAgentChatQueuedNow('t1', 'q1');
        expect(pendingTexts()).toEqual([]);
    });
});
