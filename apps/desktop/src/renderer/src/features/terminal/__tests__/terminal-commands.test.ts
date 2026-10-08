import type { BootstrapState, PaneLayout, TerminalRecord } from '@caxri/protocol';
import { CaxriError, createPaneLayout, findResourceTabs, listPanes } from '@caxri/protocol';
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

import type { ToastAction } from '../../../stores/toast-actions';
import {
    clearActiveTerminal,
    copyActiveTerminalSelection,
    createTerminal,
    createTerminalForSession,
    detachTerminalQuietly,
    didPasteIntoTerminal,
    focusTerminalById,
    getTerminalFocusElement,
    hasActiveTerminalSelection,
    isTerminalAttached,
    markTerminalAttached,
    refreshTerminalState,
    registerTerminalClearHandler,
    registerTerminalFocusHandler,
    registerTerminalInputGate,
    registerTerminalPasteHandler,
    registerTerminalSelectionHandlers,
    restartTerminal,
    restartTerminalWithRecovery,
    sendTerminalSequence,
    startNewAgentSession,
    whenTerminalAttached,
} from '../terminal-commands';

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
            { refresh: mocks.refreshWorkbench },
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

describe('focus handler registration contract', () => {
    it('routes focus to the mounted Terminal handler', () => {
        const handler = vi.fn();
        const unregister = registerTerminalFocusHandler('terminal-focus', handler);

        focusTerminalById('terminal-focus');

        expect(handler).toHaveBeenCalledTimes(1);
        unregister();
    });

    it('exposes the mounted Terminal focus element and yields null for unknown or element-less handlers', () => {
        const element = {} as HTMLElement;
        const unregister = registerTerminalFocusHandler('terminal-focus', vi.fn(), () => element);
        const unregisterBare = registerTerminalFocusHandler('terminal-bare', vi.fn());

        expect(getTerminalFocusElement('terminal-focus')).toBe(element);
        expect(getTerminalFocusElement('terminal-bare')).toBeNull();
        expect(getTerminalFocusElement('terminal-missing')).toBeNull();
        unregister();
        unregisterBare();
        expect(getTerminalFocusElement('terminal-focus')).toBeNull();
    });

    it('does not let a stale unregister callback evict a newer focus handler', () => {
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();
        const unregisterFirst = registerTerminalFocusHandler('terminal-focus', firstHandler);
        const unregisterSecond = registerTerminalFocusHandler('terminal-focus', secondHandler);

        unregisterFirst();
        focusTerminalById('terminal-focus');

        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).toHaveBeenCalledTimes(1);
        unregisterSecond();
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

describe('terminal attachment registry', () => {
    it('resolves immediately for an already attached Terminal', async () => {
        markTerminalAttached('attached-1', true);
        await expect(whenTerminalAttached('attached-1', 10)).resolves.toBe(true);
        expect(isTerminalAttached('attached-1')).toBe(true);
    });

    it('resolves pending waiters once the pane reports its attach, and no longer after unmount', async () => {
        const pending = whenTerminalAttached('attached-2', 1000);
        markTerminalAttached('attached-2', true);
        await expect(pending).resolves.toBe(true);
        markTerminalAttached('attached-2', false);
        expect(isTerminalAttached('attached-2')).toBe(false);
    });

    it('gives up after the timeout when no pane attaches', async () => {
        vi.useFakeTimers();
        try {
            const pending = whenTerminalAttached('attached-3', 50);
            await vi.advanceTimersByTimeAsync(50);
            await expect(pending).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
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
