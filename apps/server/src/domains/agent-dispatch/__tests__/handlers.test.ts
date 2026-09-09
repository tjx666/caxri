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
        const signalExact = vi.fn(() => true);
        const target = {
            launchId: 'launch-1',
            ref: ENDPOINT,
            terminalId: 'terminal-1',
        };
        const handlers = createAgentCommandHandlers({
            coordinator: {} as AgentCoordinator,
            database: {} as CaxriDatabase,
            dispatch: {} as AgentDispatchService,
            emit: vi.fn(),
            endpoints: {
                controlTarget: vi.fn(() => target),
                isCurrent: vi.fn(() => true),
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
    });

    it('accepts a reply only while the exact waiting attention generation is still current', async () => {
        const touchSessionActivity = vi.fn(() => true);
        const write = vi.fn(() => true);
        const writeAgent = vi.fn(() => Promise.resolve(true));
        const session = {
            id: 'session-1',
            primaryAgentTerminalId: 'terminal-1',
            lastActivityState: 'waiting',
            attentionEpoch: 3,
        };
        const consumeSessionAttentionReply = vi.fn(
            (_sessionId: string, _terminalId: string, attentionEpoch: number) => {
                if (
                    session.lastActivityState !== 'waiting' ||
                    session.attentionEpoch !== attentionEpoch
                )
                    return false;
                session.lastActivityState = 'running';
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
                releaseSessionAttentionReply: vi.fn(() => true),
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

        await expect(
            handlers['terminal.sendInternal']({
                terminalId: 'terminal-1',
                text: 'Continue',
                enter: true,
                attentionEpoch: 3,
            }),
        ).resolves.toMatchObject({ accepted: true, terminalId: 'terminal-1' });
        await expect(
            handlers['terminal.sendInternal']({
                terminalId: 'terminal-1',
                text: 'Stale reply',
                enter: true,
                attentionEpoch: 3,
            }),
        ).rejects.toThrow('Agent attention changed before the reply was accepted');
        expect(consumeSessionAttentionReply).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalled();
        expect(writeAgent).toHaveBeenCalledOnce();
        expect(touchSessionActivity).toHaveBeenCalledExactlyOnceWith(
            'session-1',
            'user_submission',
        );
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
                        lastActivityState: 'waiting',
                        attentionEpoch: 3,
                        lastSessionActivityAt: 40,
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
                    attentionEpoch: 3,
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
