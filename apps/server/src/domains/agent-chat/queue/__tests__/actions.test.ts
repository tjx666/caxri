import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatProviderSession } from '../../chat-provider';
import type { ChatState } from '../../chat-states';
import { deliverChatCommand } from '../actions';
import { ChatFollowUpQueue } from '../follow-up-queue';

/**
 * A Chat that lists `/compact` and `/review`, with `snapshot` as its current state; the provider records each command
 * it runs.
 */
function chatFixture(snapshot: Partial<AgentChatSnapshot>) {
    const state = {
        snapshot: {
            status: 'ready',
            queue: [],
            commands: [
                { name: 'compact', description: '' },
                { name: 'review', description: '' },
            ],
            ...snapshot,
        } as AgentChatSnapshot,
    };
    const run: string[] = [];
    const session = {
        runCommand: vi.fn((name: string, arguments_?: string) => {
            run.push(arguments_ === undefined ? name : `${name} ${arguments_}`);
            return Promise.resolve();
        }),
    } as unknown as AgentChatProviderSession;
    const followUps = new ChatFollowUpQueue({
        terminalId: 'terminal-1',
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        read: () => state.snapshot,
        apply: (operations: AgentChatPatchOperation[]) => {
            for (const operation of operations)
                if (operation.op === 'state')
                    state.snapshot = { ...state.snapshot, ...operation.state } as AgentChatSnapshot;
        },
        canDeliver: () => true,
        enqueue: async (deliver) => deliver(session),
    });
    const chat = {
        followUps,
        projection: {
            get snapshot() {
                return state.snapshot;
            },
        },
    } as unknown as ChatState;
    const queued = () => state.snapshot.queue?.map((entry) => entry.text);
    return {
        run,
        queued,
        deliver: (name: string, arguments_?: string) =>
            deliverChatCommand(session, chat, name, arguments_),
    };
}

describe('deliverChatCommand', () => {
    it('absorbs a /compact sent while a compaction already runs, instead of queueing a second one', async () => {
        const chat = chatFixture({ operation: 'compacting' });
        await chat.deliver('compact');
        expect(chat.queued()).toEqual([]);
        expect(chat.run).toEqual([]);
    });

    it('queues one /compact during a turn and absorbs a repeat of it', async () => {
        const chat = chatFixture({ activeTurnId: 'turn-1' });
        await chat.deliver('compact');
        await chat.deliver('compact', '  ');
        expect(chat.queued()).toEqual(['/compact']);
    });

    it('still queues a /compact with instructions and other commands while compacting', async () => {
        const chat = chatFixture({ operation: 'compacting' });
        await chat.deliver('compact', 'keep the API notes');
        await chat.deliver('review');
        expect(chat.queued()).toEqual(['/compact keep the API notes', '/review']);
        expect(chat.run).toEqual([]);
    });
});
