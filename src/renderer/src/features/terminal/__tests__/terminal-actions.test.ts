import type { BootstrapState, TerminalRecord } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getSelectedSession: vi.fn(),
    getSessionState: vi.fn(),
    patchSessionState: vi.fn(),
    pushToast: vi.fn(),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: boolean }?]
        ): Promise<unknown> => run(),
    ),
    useSessionViewStore: { getState: vi.fn() },
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    getSessionState: mocks.getSessionState,
}));
vi.mock('../../../stores/session-view', () => ({ useSessionViewStore: mocks.useSessionViewStore }));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/workbench', () => ({
    patchSessionState: mocks.patchSessionState,
    refreshWorkbench: mocks.refreshWorkbench,
}));

import {
    clearActiveTerminal,
    copyActiveTerminalSelection,
    didPasteIntoTerminal,
    hasActiveTerminalSelection,
    registerTerminalClearHandler,
    registerTerminalPasteHandler,
    registerTerminalSelectionHandlers,
    restartTerminal,
    sendTerminalSequence,
    startNewAgentSession,
} from '../terminal-actions';

/**
 * Content-free `TerminalRecord` fixture; only `id` and `lastProcessState`/`provider`/`agentSessionId` are exercised by
 * the behaviors under test.
 */
function terminalFixture(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'shell',
        cwd: '/repo',
        title: 'Shell',
        icon: 'terminal',
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function bootstrapWith(terminal: TerminalRecord): BootstrapState {
    return { terminals: [terminal] } as unknown as BootstrapState;
}

beforeEach(() => {
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue(undefined);
    mocks.getBootstrap.mockReset();
    mocks.getSelectedSession.mockReset();
    mocks.getSessionState.mockReset();
    mocks.patchSessionState.mockClear();
    mocks.pushToast.mockClear();
    mocks.refreshWorkbench.mockClear();
    mocks.tryCommand.mockClear();
});

describe('sendTerminalSequence', () => {
    it('sends the exact configured text through the typed Terminal input request', async () => {
        const sequence = '\u{1B}[1;3B';

        sendTerminalSequence('terminal-1', sequence);
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Terminal input failed',
            expect.any(Function),
        );
        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.input', {
            terminalId: 'terminal-1',
            data: sequence,
        });
    });
});

describe('restartTerminal (requestTerminalRestart reattach gate)', () => {
    it('reattaches before restarting when the Terminal is not currently running', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ lastProcessState: 'stopped' })),
        );

        restartTerminal('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(1, 'terminal.attach', {
            terminalId: 'terminal-1',
        });
        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(2, 'terminal.restart', {
            terminalId: 'terminal-1',
            mode: 'resume',
        });
    });

    it('skips reattachment when the Terminal is already running (avoids discarding queued live output)', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ lastProcessState: 'running' })),
        );

        restartTerminal('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.restart', {
            terminalId: 'terminal-1',
            mode: 'resume',
        });
    });

    it('reattaches when the Terminal is missing from the bootstrap snapshot entirely', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [] } as unknown as BootstrapState);

        restartTerminal('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(1, 'terminal.attach', {
            terminalId: 'terminal-1',
        });
    });
});

describe('startNewAgentSession', () => {
    it('shows an info toast and never calls the Runtime when the Terminal has no Agent session', () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ provider: undefined, agentSessionId: undefined })),
        );

        startNewAgentSession('terminal-1');

        expect(mocks.pushToast).toHaveBeenCalledWith(
            'info',
            'The active Terminal has no Agent session to replace.',
        );
        expect(mocks.tryCommand).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('shows the info toast when a provider is set but no Agent session id is bound yet', () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ provider: 'claude', agentSessionId: undefined })),
        );

        startNewAgentSession('terminal-1');

        expect(mocks.pushToast).toHaveBeenCalledWith(
            'info',
            'The active Terminal has no Agent session to replace.',
        );
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('restarts in fresh mode through tryCommand when a bound Agent session exists', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(
                terminalFixture({
                    provider: 'claude',
                    agentSessionId: 'agent-session-1',
                    lastProcessState: 'running',
                }),
            ),
        );

        startNewAgentSession('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).not.toHaveBeenCalled();
        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Starting a new Agent session failed',
            expect.any(Function),
            { refresh: true },
        );
        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.restart', {
            terminalId: 'terminal-1',
            mode: 'fresh',
        });
    });
});

describe('clear handler registration contract', () => {
    it('routes clearActiveTerminal to the registered handler', () => {
        const handler = vi.fn();
        registerTerminalClearHandler('terminal-1', handler);

        clearActiveTerminal('terminal-1');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('stops routing to the handler once its own unregister callback runs', () => {
        const handler = vi.fn();
        const unregister = registerTerminalClearHandler('terminal-1', handler);

        unregister();
        clearActiveTerminal('terminal-1');

        expect(handler).not.toHaveBeenCalled();
    });

    it('does not let a stale unregister callback evict a newer handler for the same id', () => {
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();
        const unregisterFirst = registerTerminalClearHandler('terminal-1', firstHandler);
        registerTerminalClearHandler('terminal-1', secondHandler);

        // A pane that already lost ownership (e.g. after remount) must not evict its successor.
        unregisterFirst();
        clearActiveTerminal('terminal-1');

        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).toHaveBeenCalledTimes(1);
    });
});

describe('paste handler registration contract', () => {
    it('routes data to the mounted Terminal and returns whether it accepted the paste', () => {
        const handlers = { paste: vi.fn(() => true) };
        const unregister = registerTerminalPasteHandler('terminal-paste-1', handlers);

        expect(didPasteIntoTerminal('terminal-paste-1', "'/repo/a file.txt'")).toBe(true);
        expect(handlers.paste).toHaveBeenCalledWith("'/repo/a file.txt'");

        unregister();
    });

    it('returns false after unregister and does not let stale cleanup evict a newer pane', () => {
        const firstHandlers = { paste: vi.fn(() => true) };
        const secondHandlers = { paste: vi.fn(() => true) };
        const unregisterFirst = registerTerminalPasteHandler('terminal-paste-2', firstHandlers);
        const unregisterSecond = registerTerminalPasteHandler('terminal-paste-2', secondHandlers);

        unregisterFirst();

        expect(didPasteIntoTerminal('terminal-paste-2', '/repo/folder')).toBe(true);
        expect(firstHandlers.paste).not.toHaveBeenCalled();
        expect(secondHandlers.paste).toHaveBeenCalledWith('/repo/folder');

        unregisterSecond();
        expect(didPasteIntoTerminal('terminal-paste-2', '/repo/folder')).toBe(false);
    });
});

describe('selection handler registration contract', () => {
    it('routes copySelection and hasSelection to the registered handlers', () => {
        const handlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        registerTerminalSelectionHandlers('terminal-1', handlers);

        copyActiveTerminalSelection('terminal-1');

        expect(handlers.copySelection).toHaveBeenCalledTimes(1);
        expect(hasActiveTerminalSelection('terminal-1')).toBe(true);
    });

    it('reports no selection once its own unregister callback runs', () => {
        const handlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        const unregister = registerTerminalSelectionHandlers('terminal-1', handlers);

        unregister();

        expect(hasActiveTerminalSelection('terminal-1')).toBe(false);
        copyActiveTerminalSelection('terminal-1');
        expect(handlers.copySelection).not.toHaveBeenCalled();
    });

    it('does not let a stale unregister callback evict a newer handler set for the same id', () => {
        const firstHandlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => false) };
        const secondHandlers = { copySelection: vi.fn(), hasSelection: vi.fn(() => true) };
        const unregisterFirst = registerTerminalSelectionHandlers('terminal-1', firstHandlers);
        registerTerminalSelectionHandlers('terminal-1', secondHandlers);

        unregisterFirst();

        expect(hasActiveTerminalSelection('terminal-1')).toBe(true);
        copyActiveTerminalSelection('terminal-1');
        expect(secondHandlers.copySelection).toHaveBeenCalledTimes(1);
        expect(firstHandlers.copySelection).not.toHaveBeenCalled();
    });
});
