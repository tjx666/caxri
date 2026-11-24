import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve({})),
    findPaneTabId: vi.fn((): string | undefined => undefined),
    getBootstrap: vi.fn(),
    selectPaneTab: vi.fn(),
}));

vi.mock('../../../stores/selectors', () => ({ getBootstrap: mocks.getBootstrap }));
vi.mock('../../workbench/pane-actions', () => ({
    findPaneTabId: mocks.findPaneTabId,
    selectPaneTab: mocks.selectPaneTab,
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../stores/toasts', () => ({
    pushToast: vi.fn(),
    tryCommand: (_label: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('../../../stores/session-command-convergence', () => ({
    registerSessionCommandConvergence: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
}));
vi.mock('../session-navigation-history', () => ({
    useSessionNavigationHistoryStore: {
        getState: () => ({ beginSelection: vi.fn(), settleSelection: vi.fn() }),
    },
}));

import { activateSessionRow } from '../session-commands';

describe('activateSessionRow', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.findPaneTabId.mockReset();
        mocks.getBootstrap.mockReset();
        mocks.selectPaneTab.mockClear();
    });

    it('selects an unselected Session', async () => {
        mocks.getBootstrap.mockReturnValue({ selectedSessionId: 'session-2', sessions: [] });

        activateSessionRow('session-1');

        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('session.select', {
                sessionId: 'session-1',
            }),
        );
        expect(mocks.selectPaneTab).not.toHaveBeenCalled();
    });

    it("brings the selected Session's Primary Agent tab forward", () => {
        mocks.getBootstrap.mockReturnValue({
            selectedSessionId: 'session-1',
            sessions: [{ id: 'session-1', primaryAgentTerminalId: 'terminal-1' }],
        });
        mocks.findPaneTabId.mockReturnValue('tab-terminal-1');

        activateSessionRow('session-1');

        expect(mocks.findPaneTabId).toHaveBeenCalledWith({
            kind: 'terminal',
            terminalId: 'terminal-1',
        });
        expect(mocks.selectPaneTab).toHaveBeenCalledWith('tab-terminal-1');
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('leaves the Workbench alone when the selected Session has no Primary Agent tab', () => {
        mocks.getBootstrap.mockReturnValue({
            selectedSessionId: 'session-1',
            sessions: [{ id: 'session-1' }],
        });

        activateSessionRow('session-1');

        expect(mocks.selectPaneTab).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });
});
