import type { AgentEndpointRef } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import type { CaxriDatabase } from '../../db';
import type { TerminalManager } from '../../terminal';
import { createAgentCommandHandlers } from '../handlers';
import type { AgentDispatchService } from '../service';

const ENDPOINT: AgentEndpointRef = {
    endpointId: 'endpoint-1',
    generation: 1,
    hostId: 'host-1',
};

describe('Agent command handlers', () => {
    it('signals the exact managed Agent launch instead of the outer Shell process', () => {
        const signalAgentExact = vi.fn(() => true);
        const observeInterrupt = vi.fn();
        const isCurrent = vi.fn(() => true);
        const signalExact = vi.fn(() => true);
        const target = {
            launchId: 'launch-1',
            ref: ENDPOINT,
            terminalId: 'terminal-1',
        };
        const handlers = createAgentCommandHandlers({
            coordinator: { observeInterrupt } as unknown as AgentCoordinator,
            database: { getTerminal: () => {} } as unknown as CaxriDatabase,
            dispatch: {} as AgentDispatchService,
            emit: vi.fn(),
            endpoints: {
                controlTarget: vi.fn(() => target),
                isCurrent,
            } as unknown as AgentEndpointLifecycle,
            mainOwned: () => {
                throw new Error('Unexpected public handler call');
            },
            terminals: {
                processId: vi.fn(() => 4_242),
                signalAgentExact,
                signalExact,
            } as unknown as TerminalManager,
        });

        expect(handlers['agent.control.interruptInternal']({ endpoint: ENDPOINT })).toEqual({
            endpoint: ENDPOINT,
            outcome: 'signaled',
            terminalId: 'terminal-1',
        });
        expect(signalAgentExact).toHaveBeenCalledWith('terminal-1', 'launch-1', 'SIGINT');
        expect(signalExact).not.toHaveBeenCalled();
        expect(observeInterrupt).toHaveBeenCalledExactlyOnceWith('terminal-1', 'launch-1');
        expect(handlers['agent.control.stopInternal']({ endpoint: ENDPOINT })).toMatchObject({
            outcome: 'signaled',
        });
        expect(observeInterrupt).toHaveBeenCalledOnce();
        signalAgentExact.mockReturnValue(false);
        expect(() => handlers['agent.control.interruptInternal']({ endpoint: ENDPOINT })).toThrow(
            'Agent Endpoint generation is unavailable',
        );
        expect(observeInterrupt).toHaveBeenCalledOnce();
        signalAgentExact.mockReturnValue(true);
        isCurrent.mockReturnValue(false);
        expect(() => handlers['agent.control.interruptInternal']({ endpoint: ENDPOINT })).toThrow(
            'Agent Endpoint generation is unavailable',
        );
        expect(observeInterrupt).toHaveBeenCalledOnce();
    });

    it('accepts a reply only while the exact waiting attention generation is still current', async () => {
        const touchSessionActivity = vi.fn(() => true);
        const write = vi.fn(() => true);
        const delivery = Promise.withResolvers<boolean>();
        const writeAgent = vi.fn(() => delivery.promise);
        const releaseSessionAttentionReply = vi.fn(() => true);
        const session = {
            id: 'session-1',
            primaryAgentTerminalId: 'terminal-1',
            agentActivityState: 'waiting',
            attentionGeneration: 3,
        };
        const consumeSessionAttentionReply = vi.fn(
            (_sessionId: string, _terminalId: string, attentionGeneration: number) => {
                if (
                    session.agentActivityState !== 'waiting' ||
                    session.attentionGeneration !== attentionGeneration
                )
                    return false;
                session.agentActivityState = 'running';
                return true;
            },
        );
        const handlers = createAgentCommandHandlers({
            coordinator: { observeInput: vi.fn(() => false) } as unknown as AgentCoordinator,
            database: {
                getTerminal: vi.fn(() => ({
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    kind: 'codex',
                })),
                getSession: vi.fn(() => session),
                consumeSessionAttentionReply,
                touchSessionActivity,
                releaseSessionAttentionReply,
            } as unknown as CaxriDatabase,
            dispatch: {} as AgentDispatchService,
            emit: vi.fn(),
            mainOwned: () => {
                throw new Error('Unexpected public handler call');
            },
            terminals: {
                processId: vi.fn(() => 4_242),
                write,
                writeAgent,
            } as unknown as TerminalManager,
        });

        const cancellation = new AbortController();
        const accepted = handlers['terminal.sendInternal'](
            { terminalId: 'terminal-1', text: 'Continue', enter: true, attentionGeneration: 3 },
            cancellation.signal,
        );
        await vi.waitFor(() => expect(writeAgent).toHaveBeenCalledOnce());
        cancellation.abort();
        delivery.resolve(true);
        await expect(accepted).resolves.toMatchObject({ accepted: true, terminalId: 'terminal-1' });
        await expect(
            handlers['terminal.sendInternal']({
                terminalId: 'terminal-1',
                text: 'Stale reply',
                enter: true,
                attentionGeneration: 3,
            }),
        ).rejects.toThrow('Agent attention changed before the reply was accepted');
        expect(consumeSessionAttentionReply).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalled();
        expect(writeAgent).toHaveBeenCalledOnce();
        expect(releaseSessionAttentionReply).not.toHaveBeenCalled();
        expect(touchSessionActivity).toHaveBeenCalledExactlyOnceWith(
            'session-1',
            'user_submission',
        );
    });

    it('does not consume attention or write to the PTY after a pending reply is revoked', async () => {
        const consumeSessionAttentionReply = vi.fn(() => true);
        const writeAgent = vi.fn(() => Promise.resolve(true));
        const handlers = createAgentCommandHandlers({
            coordinator: { observeInput: vi.fn(() => false) } as unknown as AgentCoordinator,
            database: {
                getTerminal: vi.fn(() => ({
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    kind: 'codex',
                })),
                getSession: vi.fn(() => ({
                    id: 'session-1',
                    primaryAgentTerminalId: 'terminal-1',
                    agentActivityState: 'waiting',
                    attentionGeneration: 3,
                })),
                consumeSessionAttentionReply,
            } as unknown as CaxriDatabase,
            dispatch: {} as AgentDispatchService,
            emit: vi.fn(),
            mainOwned: () => {
                throw new Error('Unexpected public handler call');
            },
            terminals: {
                processId: vi.fn(() => 4_242),
                writeAgent,
            } as unknown as TerminalManager,
        });
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(
            handlers['terminal.sendInternal'](
                { terminalId: 'terminal-1', text: 'Continue', enter: true, attentionGeneration: 3 },
                cancellation.signal,
            ),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(consumeSessionAttentionReply).not.toHaveBeenCalled();
        expect(writeAgent).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)(
        'releases the attention claim without promoting a rejected Agent input (%s)',
        async (failure) => {
            const releaseSessionAttentionReply = vi.fn(() => true);
            const touchSessionActivity = vi.fn(() => true);
            const handlers = createAgentCommandHandlers({
                coordinator: { observeInput: vi.fn(() => false) } as unknown as AgentCoordinator,
                database: {
                    getTerminal: vi.fn(() => ({
                        id: 'terminal-1',
                        sessionId: 'session-1',
                        kind: 'codex',
                    })),
                    getSession: vi.fn(() => ({
                        id: 'session-1',
                        primaryAgentTerminalId: 'terminal-1',
                        agentActivityState: 'waiting',
                        attentionGeneration: 3,
                        sessionActivityAt: 40,
                    })),
                    consumeSessionAttentionReply: vi.fn(() => true),
                    releaseSessionAttentionReply,
                    touchSessionActivity,
                } as unknown as CaxriDatabase,
                dispatch: {} as AgentDispatchService,
                emit: vi.fn(),
                mainOwned: () => {
                    throw new Error('Unexpected public handler call');
                },
                terminals: {
                    processId: vi.fn(() => 4_242),
                    writeAgent: vi.fn(() =>
                        failure === 'throw'
                            ? Promise.reject(new Error('Agent launch ended'))
                            : Promise.resolve(false),
                    ),
                } as unknown as TerminalManager,
            });

            await expect(
                handlers['terminal.sendInternal']({
                    terminalId: 'terminal-1',
                    text: 'Continue',
                    enter: true,
                    attentionGeneration: 3,
                }),
            ).rejects.toThrow(
                failure === 'throw' ? 'Agent launch ended' : 'Terminal is no longer running',
            );
            expect(releaseSessionAttentionReply).toHaveBeenCalledWith(
                'session-1',
                'terminal-1',
                3,
                40,
            );
            expect(touchSessionActivity).not.toHaveBeenCalled();
        },
    );
});
