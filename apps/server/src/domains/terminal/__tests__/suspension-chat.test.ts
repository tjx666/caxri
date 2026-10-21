import { describe, expect, it, vi } from 'vitest';

import { CHAT_OBSERVATION_LEASE_MS, MAX_CHAT_OBSERVATION_LEASES } from '../suspension-policy';
import { createHarness, idleAfterThirtyMinutes, terminal } from './suspension.fixture';

describe('TerminalSuspensionService: Agent Chats', () => {
    it('parks an idle background Chat through the Chat service and never through the PTY manager', async () => {
        const chats = {
            isSuspendable: vi.fn(() => true),
            readLeaseAt: vi.fn((): number | undefined => undefined),
            suspendIdle: vi.fn((terminalId: string) =>
                Promise.resolve(
                    terminal(terminalId, 'session-a', {
                        lastProcessState: 'suspended',
                        surface: 'chat',
                    }),
                ),
            ),
        };
        const harness = createHarness({ chats, settings: idleAfterThirtyMinutes });
        harness.terminals.set(
            'terminal-a',
            terminal('terminal-a', 'session-a', {
                kind: 'codex',
                provider: 'codex',
                surface: 'chat',
            }),
        );
        harness.service.start();
        harness.advance(31 * 60_000);

        expect(await harness.service.sweep()).toEqual(['terminal-a']);
        expect(chats.suspendIdle).toHaveBeenCalledWith('terminal-a', 'idle');
        expect(harness.suspend).not.toHaveBeenCalled();

        chats.isSuspendable.mockReturnValue(false);
        harness.terminals.set(
            'terminal-a',
            terminal('terminal-a', 'session-a', {
                kind: 'codex',
                provider: 'codex',
                surface: 'chat',
            }),
        );
        harness.advance(31 * 60_000);
        expect(await harness.service.sweep()).toEqual([]);
    });

    it('reclaims a Chat provider that only a read started by default, but not one used since', async () => {
        const chats = {
            isSuspendable: vi.fn(() => true),
            readLeaseAt: vi.fn((): number | undefined => undefined),
            suspendIdle: vi.fn((terminalId: string) =>
                Promise.resolve(
                    terminal(terminalId, 'session-a', {
                        lastProcessState: 'suspended',
                        surface: 'chat',
                    }),
                ),
            ),
        };
        // Idle suspension stays off (the default): only the observation lease can park this Chat.
        const harness = createHarness({ chats });
        harness.terminals.set(
            'terminal-a',
            terminal('terminal-a', 'session-a', {
                kind: 'codex',
                provider: 'codex',
                surface: 'chat',
            }),
        );
        harness.service.start();
        chats.readLeaseAt.mockReturnValue(harness.now());
        harness.advance(CHAT_OBSERVATION_LEASE_MS - 1);
        expect(await harness.service.sweep()).toEqual([]);

        harness.advance(1);
        expect(await harness.service.sweep()).toEqual(['terminal-a']);
        expect(chats.suspendIdle).toHaveBeenCalledWith('terminal-a', 'observation');
    });

    it('keeps the number of read-started Chats bounded while the user browses many in a row', async () => {
        const browsed = Array.from(
            { length: MAX_CHAT_OBSERVATION_LEASES + 2 },
            (_, index) => `chat-${index}`,
        );
        const leases = new Map<string, number>();
        const chats = {
            isSuspendable: vi.fn(() => true),
            readLeaseAt: vi.fn((terminalId: string) => leases.get(terminalId)),
            suspendIdle: vi.fn((terminalId: string) => {
                leases.delete(terminalId);
                return Promise.resolve(
                    terminal(terminalId, 'session-a', {
                        lastProcessState: 'suspended',
                        surface: 'chat',
                    }),
                );
            }),
        };
        const harness = createHarness({ chats });
        harness.service.start();
        // Each read starts a provider a second after the last, well inside the time lease.
        for (const terminalId of browsed) {
            harness.terminals.set(
                terminalId,
                terminal(terminalId, 'session-a', {
                    kind: 'codex',
                    provider: 'codex',
                    surface: 'chat',
                }),
            );
            leases.set(terminalId, harness.now());
            harness.advance(1000);
        }
        await harness.service.requestSweep();
        await vi.waitFor(() => expect(leases.size).toBe(MAX_CHAT_OBSERVATION_LEASES));
        expect(chats.suspendIdle.mock.calls).toHaveLength(2);
        expect(chats.suspendIdle.mock.calls).toEqual(
            expect.arrayContaining([
                ['chat-0', 'observation'],
                ['chat-1', 'observation'],
            ]),
        );
    });

    it('restores a Chat whose Session is reselected while its observation reclaim is in flight', async () => {
        const { promise: reclaimed, resolve: release } = Promise.withResolvers<void>();
        const reselected: string[] = [];
        const chats = {
            isSuspendable: vi.fn(() => true),
            readLeaseAt: vi.fn((): number | undefined => undefined),
            suspendIdle: vi.fn(async (terminalId: string) => {
                await reclaimed;
                return terminal(terminalId, 'session-a', {
                    lastProcessState: 'suspended',
                    surface: 'chat',
                });
            }),
        };
        const harness = createHarness({
            chats,
            onSuspendedSessionReselected: (sessionId) => reselected.push(sessionId),
            selected: 'session-b',
        });
        harness.terminals.set(
            'terminal-a',
            terminal('terminal-a', 'session-a', {
                kind: 'codex',
                provider: 'codex',
                surface: 'chat',
            }),
        );
        harness.service.start();
        chats.readLeaseAt.mockReturnValue(harness.now());
        harness.advance(CHAT_OBSERVATION_LEASE_MS);
        const sweep = harness.service.sweep();
        // The provider stop is in flight when the user selects the Chat's Session again.
        await vi.waitFor(() =>
            expect(chats.suspendIdle).toHaveBeenCalledWith('terminal-a', 'observation'),
        );
        harness.select('session-a');
        release();
        expect(await sweep).toEqual(['terminal-a']);
        expect(reselected).toEqual(['session-a']);
    });
});
