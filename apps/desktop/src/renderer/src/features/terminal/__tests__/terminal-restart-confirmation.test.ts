import type { BootstrapState, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    showConfirm: vi.fn<(...parameters: unknown[]) => Promise<boolean>>(() =>
        Promise.resolve(false),
    ),
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: vi.fn(),
    getSessionState: vi.fn(),
}));
vi.mock('../../../stores/session-view', () => ({ useSessionViewStore: { getState: vi.fn() } }));
vi.mock('../../../stores/toasts', () => ({ pushToast: vi.fn(), tryCommand: mocks.tryCommand }));
vi.mock('../../../stores/workbench', () => ({
    patchSessionState: vi.fn(),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
}));

import { restartTerminal, startNewAgentSession } from '../terminal-commands';

/**
 * A Claude Primary Agent mid-turn: the state every entry point that ends an Agent Run must confirm before acting on.
 */
const runningAgent = {
    id: 'terminal-1',
    sessionId: 'session-1',
    kind: 'claude',
    provider: 'claude',
    agentSessionId: 'agent-session-1',
    lastProcessState: 'running',
    lastAgentProcessState: 'running',
} as TerminalRecord;

const runningBootstrap = {
    terminals: [runningAgent],
    sessions: [
        { id: 'session-1', primaryAgentTerminalId: 'terminal-1', lastActivityState: 'running' },
    ],
} as unknown as BootstrapState;

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.showConfirm.mockClear();
    mocks.tryCommand.mockClear();
    mocks.getBootstrap.mockReturnValue(runningBootstrap);
});

describe('restartTerminal running-turn confirmation', () => {
    it('asks before restarting an Agent mid-turn and restarts nothing when cancelled', async () => {
        restartTerminal('terminal-1');
        await vi.waitFor(() => expect(mocks.showConfirm).toHaveBeenCalledOnce());
        await Promise.resolve();

        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({ confirmLabel: 'Stop and Restart' }),
        );
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('restarts with the Restart Agent failure title once confirmed', async () => {
        mocks.showConfirm.mockResolvedValueOnce(true);

        restartTerminal('terminal-1');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.restart', {
                terminalId: 'terminal-1',
                mode: 'resume',
            }),
        );
        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Restart Agent failed',
            expect.any(Function),
            expect.anything(),
        );
    });
});

describe('startNewAgentSession running-turn confirmation', () => {
    it('asks before a new Agent Session ends a running turn', async () => {
        startNewAgentSession('terminal-1');
        await vi.waitFor(() => expect(mocks.showConfirm).toHaveBeenCalledOnce());

        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({ confirmLabel: 'Stop and Start New' }),
        );
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });
});
