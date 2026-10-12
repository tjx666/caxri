import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToastKind, ToastOptions } from '../../../stores/toasts';

/**
 * Split out of `session-commands.test.ts` (issue #1336's #905 regression pushed that file past the 800-line `max-lines`
 * gate): the New Session creation trio (`beginSessionCreation`, `chooseSessionTerminalKind`, `confirmPendingSession`)
 * is a cohesive cluster on its own, per `source-layout`'s "split a cohesive module before the gate" guidance. The mock
 * setup below is deliberately a verbatim copy of the sibling file's, not a trimmed one: reusing the already-proven
 * wiring is safer than re-deriving which fields this narrower slice actually needs.
 */
const mocks = vi.hoisted(() => {
    const pushToast = vi.fn<(kind: ToastKind, message: string, options?: ToastOptions) => void>();
    return {
        askAgentForProject: vi.fn(),
        caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
        closeCreateSessionMenu: vi.fn(),
        copyFilePath: vi.fn(() => Promise.resolve()),
        dropSessions: vi.fn(),
        getBootstrap: vi.fn(),
        openCreateSessionMenu: vi.fn(),
        pendingProjectId: undefined as string | undefined,
        pendingRoot: undefined as string | undefined,
        primarySidebarVisible: true,
        setPrimarySidebarVisible: vi.fn(),
        getQueryData: vi.fn(),
        getSelectedSession: vi.fn(),
        openExternalUrl: vi.fn(() => Promise.resolve()),
        pushToast,
        registerSessionCommandConvergence: vi.fn(() => ({
            cancel: vi.fn(),
            promise: Promise.resolve(),
        })),
        refreshWorkbench: vi.fn(() => Promise.resolve()),
        removeSessionQueries: vi.fn(),
        selectSelectedProject: vi.fn(),
        /**
         * Mirrors the real funnel's swallow-and-report contract rather than only forwarding `run`: an action offered
         * inside a toast must survive its own request failing, which is unobservable when the double re-throws.
         */
        tryCommand: vi.fn(
            async (
                ...[label, run]: [
                    string,
                    () => Promise<unknown>,
                    { refresh?: () => Promise<void> }?,
                ]
            ): Promise<unknown> => {
                try {
                    return await run();
                } catch (error) {
                    pushToast('error', `${label}: ${(error as Error).message}`);
                    return undefined;
                }
            },
        ),
        writeText: vi.fn(() => Promise.resolve()),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../lib/copy-file-path', () => ({ copyFilePath: mocks.copyFilePath }));
vi.mock('../../../lib/external-link', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../../../queries/client', () => ({
    caxriQueryKey: (method: string, parameters: unknown) => [method, parameters],
    queryClient: { getQueryData: mocks.getQueryData },
}));
vi.mock('../../../queries/invalidation', () => ({
    removeSessionQueries: mocks.removeSessionQueries,
}));
vi.mock('../../../stores/chrome-layout', () => ({
    useChromeLayoutStore: {
        getState: vi.fn(() => ({
            primarySidebarVisible: mocks.primarySidebarVisible,
            setPrimarySidebarVisible: mocks.setPrimarySidebarVisible,
        })),
    },
}));
vi.mock('../../../stores/dialogs', () => ({
    clearPendingSession: vi.fn(),
    useDialogStore: {
        getState: vi.fn(() => ({
            askAgentForProject: mocks.askAgentForProject,
            closeCreateSessionMenu: mocks.closeCreateSessionMenu,
            openCreateSessionMenu: mocks.openCreateSessionMenu,
            pendingProjectId: mocks.pendingProjectId,
            pendingRoot: mocks.pendingRoot,
        })),
    },
}));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    selectSelectedProject: mocks.selectSelectedProject,
    selectSelectedSession: vi.fn(),
}));
vi.mock('../../../stores/session-view', () => ({
    useSessionViewStore: { getState: vi.fn(() => ({ dropSessions: mocks.dropSessions })) },
}));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/session-command-convergence', () => ({
    registerSessionCommandConvergence: mocks.registerSessionCommandConvergence,
}));
vi.mock('../../../stores/workbench', () => ({
    refreshWorkbench: mocks.refreshWorkbench,
    useWorkbenchStore: { getState: () => ({ bootstrap: undefined }) },
}));

import type { CreateSessionAnchor } from '../../../stores/dialogs';
import {
    beginSessionCreation,
    chooseSessionTerminalKind,
    confirmPendingSession,
} from '../session-creation-commands';

describe('Session creation commands', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });
        mocks.askAgentForProject.mockClear();
        mocks.caxriRequest.mockClear();
        mocks.copyFilePath.mockClear();
        mocks.pushToast.mockClear();
        mocks.writeText.mockClear();
        mocks.dropSessions.mockClear();
        mocks.getBootstrap.mockReset();
        mocks.getQueryData.mockReset();
        mocks.getSelectedSession.mockReset();
        mocks.openExternalUrl.mockClear();
        mocks.pushToast.mockClear();
        mocks.registerSessionCommandConvergence.mockClear();
        mocks.refreshWorkbench.mockClear();
        mocks.removeSessionQueries.mockClear();
        mocks.selectSelectedProject.mockReset();
        mocks.tryCommand.mockClear();
        mocks.closeCreateSessionMenu.mockClear();
        mocks.openCreateSessionMenu.mockClear();
        mocks.setPrimarySidebarVisible.mockClear();
        mocks.pendingProjectId = undefined;
        mocks.pendingRoot = undefined;
        mocks.primarySidebarVisible = true;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('skips the Terminal choice entirely when a default Agent is configured', async () => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.defaultAgent': 'codex' } });

        beginSessionCreation('project-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: 'codex',
        });
        expect(mocks.openCreateSessionMenu).not.toHaveBeenCalled();
    });

    it('opens a Chat-capable default Agent as a Chat when Open in Chat is on', async () => {
        mocks.getBootstrap.mockReturnValue({
            settings: { 'session.defaultAgent': 'codex', 'session.openAgentsInChat': true },
        });

        beginSessionCreation('project-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: 'codex',
            surface: 'chat',
        });
    });

    it('keeps the Shell on a PTY even when Open in Chat is on', async () => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.openAgentsInChat': true } });

        chooseSessionTerminalKind('project-1', 'shell');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: 'shell',
        });
    });

    /**
     * A configured default Agent must short-circuit every activation of the trigger, not just the first: the trigger
     * used to route the "open" request through Base UI's controlled `Menu`, whose `open` prop this branch never flips
     * `true`. That desynced Base UI's internal interaction state from the prop after the first click and left the
     * second (and every later) activation producing no `onOpenChange` and therefore no `session.create` at all: exactly
     * the "Project empties out, New Session goes dead" report in github.com/tjx666/caxri/issues/905. The fix moved the
     * trigger's `onClick` to call `beginSessionCreation` directly instead of going through `Menu`, so this asserts the
     * function itself keeps producing one independent `session.create` per activation.
     */
    it('creates a new Session on every activation when a default Agent is configured', async () => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.defaultAgent': 'shell' } });

        beginSessionCreation('project-1');
        await mocks.tryCommand.mock.results[0]?.value;
        beginSessionCreation('project-1');
        await mocks.tryCommand.mock.results[1]?.value;

        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(1, 'session.create', {
            projectId: 'project-1',
            defaultAgent: 'shell',
        });
        expect(mocks.caxriRequest).toHaveBeenNthCalledWith(2, 'session.create', {
            projectId: 'project-1',
            defaultAgent: 'shell',
        });
        expect(mocks.openCreateSessionMenu).not.toHaveBeenCalled();
    });

    /**
     * The claim names the trigger as well as the Project: a Project with no Sessions renders a second New Session
     * button below its heading, and marking only the Project would let both rows open a popup over one choice.
     */
    it.each<{ anchor?: CreateSessionAnchor; basis: string; expected: CreateSessionAnchor }>([
        { basis: 'the Project heading by default', expected: 'heading' },
        { basis: 'the caller-named trigger', anchor: 'emptyProject', expected: 'emptyProject' },
    ])('anchors the menu to $basis when no default Agent is configured', ({ anchor, expected }) => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.defaultAgent': null } });

        if (anchor) beginSessionCreation('project-1', anchor);
        else beginSessionCreation('project-1');

        expect(mocks.openCreateSessionMenu).toHaveBeenCalledWith('project-1', expected);
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(mocks.setPrimarySidebarVisible).not.toHaveBeenCalled();
    });

    /**
     * The menu is anchored inside the Primary Side Bar, so `session.create` reaching this action from the native menu,
     * a shortcut, or the command palette would otherwise mark a Project whose row is not mounted and do nothing at
     * all.
     */
    it('reveals a collapsed Primary Side Bar before marking the Project', () => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.defaultAgent': null } });
        mocks.primarySidebarVisible = false;

        beginSessionCreation('project-1');

        expect(mocks.setPrimarySidebarVisible).toHaveBeenCalledWith(true);
        expect(mocks.openCreateSessionMenu).toHaveBeenCalledWith('project-1', 'heading');
    });

    it('leaves the Primary Side Bar alone when the default Agent short-circuits the choice', async () => {
        mocks.getBootstrap.mockReturnValue({ settings: { 'session.defaultAgent': 'claude' } });
        mocks.primarySidebarVisible = false;

        beginSessionCreation('project-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.setPrimarySidebarVisible).not.toHaveBeenCalled();
    });

    it('closes the menu and creates the Session with the chosen kind', async () => {
        chooseSessionTerminalKind('project-1', 'grok');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.closeCreateSessionMenu).toHaveBeenCalled();
        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: 'grok',
        });
    });

    it('creates a Session with no Terminal when the user starts without one', async () => {
        chooseSessionTerminalKind('project-1', null);
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: null,
        });
    });

    it('creates the Session from the centered fallback dialog with the chosen kind', async () => {
        mocks.pendingProjectId = 'project-2';

        confirmPendingSession('codex');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('session.create', {
            projectId: 'project-2',
            defaultAgent: 'codex',
        });
    });
});
