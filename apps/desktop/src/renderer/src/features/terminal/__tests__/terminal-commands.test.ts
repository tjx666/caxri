import type { BootstrapState, PaneLayout, TerminalRecord } from '@caxri/protocol';
import {
    CaxriError,
    createPaneLayout,
    findPane,
    findResourceTabs,
    listPanes,
    openResource,
    selectTab,
} from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getSelectedSession: vi.fn(),
    getSessionState: vi.fn(),
    patchSessionState: vi.fn(),
    pushToast: vi.fn(),
    refreshWorkbench: vi.fn(() => Promise.resolve()),
    showConfirm: vi.fn<(...parameters: unknown[]) => Promise<boolean>>(() => Promise.resolve(true)),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: () => Promise<void> }?]
        ): Promise<unknown> => {
            try {
                return await run();
            } catch {
                return undefined;
            }
        },
    ),
    useSessionViewStore: { getState: vi.fn() },
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
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

import type { ToastAction } from '../../../stores/toast-actions';
import {
    createTerminal,
    createTerminalForSession,
    detachTerminalQuietly,
    refreshTerminalState,
    restartTerminal,
    restartTerminalWithRecovery,
    sendTerminalSequence,
    startNewAgentSession,
} from '../terminal-commands';
import { registerTerminalInputGate } from '../terminal-pane-handlers';

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
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function bootstrapWith(terminal: TerminalRecord): BootstrapState {
    return { terminals: [terminal], sessions: [] } as unknown as BootstrapState;
}

/**
 * The follow-up a failed command offers. It is plain data now: a name plus the parameters to replay it with, so the
 * notification center can still offer it long after the toast expired; the tests below assert the offer here and the
 * work it performs by calling the same exported entry point the handler table routes to.
 */
function recoveryOf(call: number): (error?: unknown) => ToastAction {
    const options = mocks.tryCommand.mock.calls[call]?.[2] as unknown as {
        recovery: (error?: unknown) => ToastAction;
    };
    return options.recovery;
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
    mocks.showConfirm.mockClear();
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

    it('sends nothing while the mounted Terminal input gate is locked', () => {
        const unregister = registerTerminalInputGate('terminal-locked', () => false);

        sendTerminalSequence('terminal-locked', '\r');

        expect(mocks.tryCommand).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        unregister();
    });
});

describe('restartTerminal (requestTerminalRestart reattach gate)', () => {
    it('offers Retry when reattachment fails before restart was submitted', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ lastProcessState: 'stopped' })),
        );
        mocks.caxriRequest.mockRejectedValueOnce(new Error('attach failed'));

        restartTerminal('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(recoveryOf(0)()).toEqual({
            id: 'terminal.restart',
            params: { terminalId: 'terminal-1' },
        });

        // What that follow-up runs, exercised through the same entry point the notification's handler table calls.
        restartTerminalWithRecovery('terminal-1');
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(3, 'terminal.restart', {
            terminalId: 'terminal-1',
            mode: 'resume',
        });
    });

    it('refreshes instead of restarting again when the first restart outcome is uncertain', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(terminalFixture({ lastProcessState: 'running' })),
        );

        restartTerminal('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(recoveryOf(0)()).toEqual({ id: 'terminal.refresh' });

        refreshTerminalState();
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
        expect(mocks.refreshWorkbench).toHaveBeenCalled();
    });

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

describe('createTerminal recovery', () => {
    it('retries the original Session and placement after selection changes', async () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' });
        mocks.caxriRequest.mockResolvedValue({ id: 'terminal-1' });

        await createTerminal('shell', { cwd: '/repo', paneId: 'pane-1' });
        mocks.getSelectedSession.mockReturnValue({ id: 'session-2' });

        // The Session and placement are captured into the recorded parameters, so a retry taken after the selection
        // moved still creates the Terminal the user asked for rather than one in whatever is selected now.
        const action = recoveryOf(0)(new CaxriError('IO', 'Working directory is unavailable'));
        expect(action).toEqual({
            id: 'terminal.create',
            params: {
                sessionId: 'session-1',
                kind: 'shell',
                cwd: '/repo',
                paneId: 'pane-1',
                split: undefined,
            },
        });

        await createTerminalForSession('session-1', 'shell', { cwd: '/repo', paneId: 'pane-1' });

        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(2, 'terminal.create', {
            sessionId: 'session-1',
            kind: 'shell',
            cwd: '/repo',
        });
    });

    it('refreshes instead of creating a duplicate after an uncertain result', async () => {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' });
        mocks.caxriRequest.mockResolvedValue({ id: 'terminal-1' });

        await createTerminal();

        expect(recoveryOf(0)(new CaxriError('TIMEOUT', 'No response'))).toEqual({
            id: 'terminal.refresh',
        });

        refreshTerminalState();
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
        expect(mocks.refreshWorkbench).toHaveBeenCalled();
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
            'The active Terminal has no conversation to replace.',
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
            'The active Terminal has no conversation to replace.',
        );
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('confirms, then restarts in fresh mode through tryCommand when a bound Agent session exists', async () => {
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
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.restart', {
                terminalId: 'terminal-1',
                mode: 'fresh',
            }),
        );

        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                confirmLabel: 'Start New',
                title: 'Start a new conversation?',
            }),
        );
        expect(mocks.pushToast).not.toHaveBeenCalled();
        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Starting a new conversation failed',
            expect.any(Function),
            { refresh: mocks.refreshWorkbench },
        );
    });

    it('never clears the binding of an idle or exited Agent when the confirmation is cancelled', async () => {
        mocks.showConfirm.mockResolvedValueOnce(false);
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(
                terminalFixture({
                    provider: 'claude',
                    agentSessionId: 'agent-session-1',
                    lastProcessState: 'stopped',
                }),
            ),
        );

        startNewAgentSession('terminal-1');
        await vi.waitFor(() => expect(mocks.showConfirm).toHaveBeenCalledOnce());
        await Promise.resolve();

        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });
});

describe('createTerminal', () => {
    function stubSessionState(paneLayout = createPaneLayout()): void {
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' });
        mocks.getSessionState.mockReturnValue({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            paneLayout,
        });
        mocks.caxriRequest.mockResolvedValue(terminalFixture({ id: 'terminal-new' }));
    }

    it('places the new Terminal into the layout once it exists', async () => {
        stubSessionState();
        mocks.getBootstrap.mockReturnValue(bootstrapWith(terminalFixture({ id: 'terminal-new' })));

        await createTerminal();

        expect(mocks.patchSessionState).toHaveBeenCalledTimes(1);
    });

    /**
     * `Cmd+T` then `Cmd+W`: the close lands while `createTerminal` is still awaiting its refresh, so the Terminal is
     * already gone by the time the placement would run. Writing the tab back would strand a blank pane.
     */
    it('opens no tab for a Terminal that was closed before the refresh returned', async () => {
        stubSessionState();
        mocks.getBootstrap.mockReturnValue(bootstrapWith(terminalFixture({ id: 'terminal-1' })));

        await createTerminal();

        expect(mocks.patchSessionState).not.toHaveBeenCalled();
    });

    it('leaves the split pane showing the tab it showed before a fresh Terminal splits off it', async () => {
        let next = 0;
        const id = () => `selection-${++next}`;
        let layout = createPaneLayout({ kind: 'terminal', terminalId: 'terminal-chat' }, id);
        layout = openResource(layout, { kind: 'terminal', terminalId: 'terminal-other' }, {}, id);
        const chatTab = findResourceTabs(layout, {
            kind: 'terminal',
            terminalId: 'terminal-chat',
        })[0];
        layout = selectTab(layout, chatTab.tab.id);
        stubSessionState(layout);
        mocks.getBootstrap.mockReturnValue(bootstrapWith(terminalFixture({ id: 'terminal-new' })));

        await createTerminal('shell', { paneId: chatTab.pane.id, split: 'down' });

        const nextLayout = (
            mocks.patchSessionState.mock.calls as Array<[{ paneLayout: PaneLayout }]>
        )[0]?.[0]?.paneLayout;
        expect(findPane(nextLayout, chatTab.pane.id)?.activeTabId).toBe(chatTab.tab.id);
        const newTerminal = findResourceTabs(nextLayout, {
            kind: 'terminal',
            terminalId: 'terminal-new',
        })[0];
        expect(nextLayout.activePaneId).toBe(newTerminal.pane.id);
    });

    it('keeps the active Terminal in place when opening a fresh Terminal in a split pane', async () => {
        const layout = createPaneLayout(
            { kind: 'terminal', terminalId: 'terminal-existing' },
            (() => {
                let next = 0;
                return () => `layout-${++next}`;
            })(),
        );
        stubSessionState(layout);
        mocks.getBootstrap.mockReturnValue(bootstrapWith(terminalFixture({ id: 'terminal-new' })));

        await createTerminal('shell', { split: 'right' });

        const nextLayout = (
            mocks.patchSessionState.mock.calls as Array<[{ paneLayout: PaneLayout }]>
        )[0]?.[0]?.paneLayout;
        expect(nextLayout.root).toMatchObject({ type: 'split', direction: 'horizontal' });
        if (nextLayout.root.type !== 'split') throw new Error('Expected a horizontal pane split');
        expect(nextLayout.root.first).toMatchObject({ type: 'pane', id: layout.root.id });
        expect(nextLayout.root.second).toMatchObject({
            type: 'pane',
            tabs: [{ resource: { kind: 'terminal', terminalId: 'terminal-new' } }],
        });
        expect(listPanes(nextLayout)).toHaveLength(2);
        expect(
            findResourceTabs(nextLayout, {
                kind: 'terminal',
                terminalId: 'terminal-existing',
            }),
        ).toHaveLength(1);
        expect(
            findResourceTabs(nextLayout, { kind: 'terminal', terminalId: 'terminal-new' }),
        ).toHaveLength(1);
        expect(
            findResourceTabs(nextLayout, {
                kind: 'terminal',
                terminalId: 'terminal-existing',
            })[0]?.pane.id,
        ).toBe(layout.root.id);
        expect(
            findResourceTabs(nextLayout, { kind: 'terminal', terminalId: 'terminal-new' })[0]?.pane
                .id,
        ).not.toBe(layout.root.id);
    });
});

describe('detachTerminalQuietly', () => {
    it('requests terminal.detach with the given terminal id', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(undefined);

        await detachTerminalQuietly('terminal-1');

        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.detach', {
            terminalId: 'terminal-1',
        });
    });

    it('swallows a rejecting request instead of throwing', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('detach failed'));

        await expect(detachTerminalQuietly('terminal-1')).resolves.toBeUndefined();
    });
});
