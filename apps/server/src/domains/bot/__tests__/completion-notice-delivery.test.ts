import type { AgentDelegationReceipt, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { createBotCompletionNotifier } from '../completion-notice-delivery';
import { botRowReader } from './bot-rows-fake';
import { pendingStore } from './pending-notices-fake';

function receipt(): AgentDelegationReceipt {
    return {
        delegationId: 'delegation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        callerTerminalId: 'bot-terminal',
        provider: 'codex',
        status: 'completed',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
    };
}

describe('createBotCompletionNotifier', () => {
    /**
     * Drives one notice through a real notifier bound to fakes, with Caxri Bot's Terminal on the given surface.
     */
    async function deliver(
        surface: 'chat' | 'pty',
        sendResult: Promise<void> = Promise.resolve(),
        isPasteDelivered = true,
    ) {
        const send = vi.fn(() => sendResult);
        const failed = vi.fn();
        /**
         * Acknowledges each accepted write on the next microtask, like the Terminal Host, with the paste's outcome
         * chosen by the test.
         */
        const writeAgentExact = vi.fn(
            (
                _terminalId: string,
                data: string,
                _launchId: string,
                _origin?: string,
                onDelivered?: (wasAccepted: boolean) => void,
            ) => {
                queueMicrotask(() => onDelivered?.(data === '\r' || isPasteDelivered));
                return true;
            },
        );
        const delivered = vi.fn();
        const notifier = createBotCompletionNotifier({
            agentChat: { send },
            coordinator: { hasIdleProof: () => true },
            database: {
                caxriBotRows: () => ({
                    projectId: 'bot-project',
                    sessionId: 'bot-session',
                    terminalId: 'bot-terminal',
                    sessionIds: ['session-1'],
                }),
                ...botRowReader(() => 'bot-terminal'),
                botPendingNotices: pendingStore(),
                getSession: () =>
                    ({
                        lastActivityState: 'idle',
                        projectId: 'bot-project',
                    }) as SessionRecord,
                getTerminal: (id: string) =>
                    ({ id, sessionId: 'bot-session', surface }) as TerminalRecord,
            },
            logger: {
                write: (_level: unknown, event: unknown) => {
                    if (String(event).endsWith('completion_notice_delivered')) delivered();
                    if (String(event).endsWith('completion_notice_delivery_failed')) failed();
                },
            } as never,
            terminals: { inputEpoch: () => 0, writeAgentExact },
        });
        const botSignal = (phase: AgentLifecycleSignal['phase']) =>
            ({
                phase,
                agentTurnId: 'turn-1',
                launchId: 'launch-1',
                provider: 'codex',
                terminalId: 'bot-terminal',
            }) as AgentLifecycleSignal;
        notifier.onLifecycleApplied(botSignal('turnStarted'));
        notifier.onLifecycleApplied(botSignal('turnFinished'));
        notifier.notifyReceiptChanged(receipt());
        await vi.waitFor(() =>
            expect(
                send.mock.calls.length + writeAgentExact.mock.calls.length,
            ).toBeGreaterThanOrEqual(1),
        );
        await Promise.resolve();
        return { delivered, failed, send, writeAgentExact };
    }

    it('sends a Chat Caxri Bot the notice as a Chat message, without a line terminator', async () => {
        const { delivered, send, writeAgentExact } = await deliver('chat');

        expect(writeAgentExact).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(
            'bot-terminal',
            {
                text: '[Caxri notice] 1 delegation update: delegation delegation-1 in Session session-1 completed.',
            },
            'queue',
            'delegation',
        );
        expect(delivered).toHaveBeenCalledOnce();
    });

    it('reports a Chat notice the Chat refused as unconfirmed', async () => {
        const { failed } = await deliver('chat', Promise.reject(new Error('Chat is not running')));

        await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    });

    /**
     * Claude Code reads one chunk carrying both the line and its Enter as a paste and keeps the Enter as a new draft
     * line, so the notice sat unsent in a Claude Caxri Bot's composer.
     */
    it('pastes the line, then presses Enter once the paste landed, for a PTY Caxri Bot', async () => {
        const { failed, send, writeAgentExact } = await deliver('pty');

        await vi.waitFor(() => expect(writeAgentExact).toHaveBeenCalledTimes(2));
        expect(send).not.toHaveBeenCalled();
        expect(writeAgentExact.mock.calls.map((call) => call.slice(0, 4))).toEqual([
            [
                'bot-terminal',
                '\u{1B}[200~[Caxri notice] 1 delegation update: delegation delegation-1 in Session session-1 completed.\u{1B}[201~',
                'launch-1',
                'delegation',
            ],
            ['bot-terminal', '\r', 'launch-1', 'delegation'],
        ]);
        expect(failed).not.toHaveBeenCalled();
    });

    it('presses no Enter after a paste the Terminal Host did not confirm, and reports it unconfirmed', async () => {
        const { failed, writeAgentExact } = await deliver('pty', Promise.resolve(), false);

        await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
        expect(writeAgentExact).toHaveBeenCalledOnce();
    });
});
