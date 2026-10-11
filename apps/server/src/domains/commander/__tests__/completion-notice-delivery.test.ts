import type { AgentDelegationReceipt, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { createCommanderCompletionNotifier } from '../completion-notice';
import { commanderRowReader } from './commander-rows-fake';
import { pendingStore } from './pending-notices-fake';

function receipt(): AgentDelegationReceipt {
    return {
        delegationId: 'delegation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        callerTerminalId: 'commander-terminal',
        provider: 'codex',
        status: 'completed',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
    };
}

describe('createCommanderCompletionNotifier', () => {
    /**
     * Drives one notice through a real notifier bound to fakes, with the Commander Terminal on the given surface.
     */
    async function deliver(surface: 'chat' | 'pty', sendResult: Promise<void> = Promise.resolve()) {
        const send = vi.fn(() => sendResult);
        const failed = vi.fn();
        const writeAgentExact = vi.fn(() => true);
        const delivered = vi.fn();
        const notifier = createCommanderCompletionNotifier({
            agentChat: { send },
            coordinator: { hasIdleProof: () => true },
            database: {
                agentCommanderRows: () => ({
                    projectId: 'commander-project',
                    sessionId: 'commander-session',
                    terminalId: 'commander-terminal',
                    sessionIds: ['session-1'],
                }),
                ...commanderRowReader(() => 'commander-terminal'),
                commanderPendingNotices: pendingStore(),
                getSession: () =>
                    ({
                        lastActivityState: 'idle',
                        projectId: 'commander-project',
                    }) as SessionRecord,
                getTerminal: (id: string) =>
                    ({ id, sessionId: 'commander-session', surface }) as TerminalRecord,
            },
            logger: {
                write: (_level: unknown, event: unknown) => {
                    if (String(event).endsWith('completion_notice_delivered')) delivered();
                    if (String(event).endsWith('completion_notice_delivery_failed')) failed();
                },
            } as never,
            terminals: { inputEpoch: () => 0, writeAgentExact },
        });
        const commanderSignal = (phase: AgentLifecycleSignal['phase']) =>
            ({
                phase,
                agentTurnId: 'turn-1',
                launchId: 'launch-1',
                provider: 'codex',
                terminalId: 'commander-terminal',
            }) as AgentLifecycleSignal;
        notifier.onLifecycleApplied(commanderSignal('turnStarted'));
        notifier.onLifecycleApplied(commanderSignal('turnFinished'));
        notifier.notifyReceiptChanged(receipt());
        await vi.waitFor(() =>
            expect(send.mock.calls.length + writeAgentExact.mock.calls.length).toBe(1),
        );
        await Promise.resolve();
        return { delivered, failed, send, writeAgentExact };
    }

    it('sends a Chat Commander the notice as a Chat message, without a line terminator', async () => {
        const { delivered, send, writeAgentExact } = await deliver('chat');

        expect(writeAgentExact).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('commander-terminal', {
            text: '[Caxri notice] 1 delegation update: delegation delegation-1 in Session session-1 completed.',
        });
        expect(delivered).toHaveBeenCalledOnce();
    });

    it('reports a Chat notice the Chat refused as unconfirmed', async () => {
        const { failed } = await deliver('chat', Promise.reject(new Error('Chat is not running')));

        await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    });

    it('presses Enter after the line for a PTY Commander', async () => {
        const { send, writeAgentExact } = await deliver('pty');

        expect(send).not.toHaveBeenCalled();
        expect(writeAgentExact).toHaveBeenCalledWith(
            'commander-terminal',
            expect.stringMatching(/completed\.\r$/),
            'launch-1',
            'delegation',
            expect.any(Function),
        );
    });
});
