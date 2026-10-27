import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    confirmTurnOffHardwareAcceleration: vi.fn(),
    createTerminalForSession: vi.fn(),
    executeCommand: vi.fn(),
    getBootstrap: vi.fn(),
    openHardwareAccelerationSettings: vi.fn(),
    openReleaseNotes: vi.fn(),
    openSettings: vi.fn(),
    request: vi.fn(),
    refreshTerminalState: vi.fn(),
    restartTerminalWithRecovery: vi.fn(),
    retrySaveDocument: vi.fn(),
    saveRetryUnavailableReason: vi.fn(),
    showUpdateDialog: vi.fn(),
    tryCommand: vi.fn(),
    unarchiveSession: vi.fn(),
    undoFollowedWorkbenchRoot: vi.fn(),
    writeText: vi.fn(),
}));

vi.mock('../features/editor/discarded-buffers', () => ({
    discardedChangesUnavailableReason: vi.fn(),
    restoreDiscardedChanges: vi.fn(),
}));
vi.mock('../features/editor/document-save-retry-commands', () => ({
    retrySaveDocument: mocks.retrySaveDocument,
    saveRetryUnavailableReason: mocks.saveRetryUnavailableReason,
}));
vi.mock('../features/gpu/gpu-commands', () => ({
    confirmTurnOffHardwareAcceleration: mocks.confirmTurnOffHardwareAcceleration,
    openHardwareAccelerationSettings: mocks.openHardwareAccelerationSettings,
}));
vi.mock('../features/session/session-archive-commands', () => ({
    unarchiveSession: mocks.unarchiveSession,
}));
vi.mock('../features/terminal/terminal-commands', () => ({
    createTerminalForSession: mocks.createTerminalForSession,
    refreshTerminalState: mocks.refreshTerminalState,
    restartTerminalWithRecovery: mocks.restartTerminalWithRecovery,
}));
vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../features/updates/update-commands', () => ({
    installUpdate: vi.fn(),
    openReleaseNotes: mocks.openReleaseNotes,
    showUpdateDialog: mocks.showUpdateDialog,
}));
vi.mock('./execute', () => ({ executeCommand: mocks.executeCommand }));
vi.mock('../stores/dialogs', () => ({ openSettings: mocks.openSettings }));
vi.mock('../stores/selectors', () => ({ getBootstrap: mocks.getBootstrap }));
vi.mock('../stores/toasts', () => ({ pushToast: vi.fn(), tryCommand: mocks.tryCommand }));
vi.mock('../stores/workbench-root-notice', () => ({
    undoFollowedWorkbenchRoot: mocks.undoFollowedWorkbenchRoot,
}));

import {
    configureToastActions,
    runToastAction,
    toastActionLabelKeys,
} from '../stores/toast-actions';
import { toastActionHandlers } from './toast-actions';

vi.mock('../lib/clipboard', () => ({
    textClipboard: { writeText: mocks.writeText },
    writeClipboardText: mocks.writeText,
}));

const SESSION = { id: 'session-1', workbenchProjectId: 'project-followed' };
const TERMINAL = { id: 'terminal-1', processId: 4_321 };

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getBootstrap.mockReturnValue({ sessions: [SESSION], terminals: [TERMINAL] });
    mocks.tryCommand.mockImplementation((_label: string, run: () => unknown) => run());
    configureToastActions(toastActionHandlers);
});

/**
 * Five follow-ups carry no parameters, which makes their handler entries structurally identical: swapping two of them
 * would pass typecheck and every other test in the repository. Only asserting the id-to-entry-point pairing catches it,
 * and that pairing is the whole contract this module exists to hold.
 */
describe('toast action handlers', () => {
    it('routes every follow-up to its own entry point', () => {
        expect(runToastAction({ id: 'settings.open' })).toBeUndefined();
        expect(mocks.openSettings).toHaveBeenCalledOnce();

        expect(runToastAction({ id: 'settings.openHardwareAcceleration' })).toBeUndefined();
        expect(mocks.openHardwareAccelerationSettings).toHaveBeenCalledOnce();
        // Acceleration is already off for this session, so this route must not re-open the confirmation.
        expect(mocks.confirmTurnOffHardwareAcceleration).not.toHaveBeenCalled();

        expect(runToastAction({ id: 'settings.turnOffHardwareAcceleration' })).toBeUndefined();
        expect(mocks.confirmTurnOffHardwareAcceleration).toHaveBeenCalledOnce();

        expect(runToastAction({ id: 'terminal.refresh' })).toBeUndefined();
        expect(mocks.refreshTerminalState).toHaveBeenCalledOnce();

        expect(runToastAction({ id: 'updates.show' })).toBeUndefined();
        expect(mocks.showUpdateDialog).toHaveBeenCalledOnce();

        expect(
            runToastAction({ id: 'updates.releaseNotes', params: { version: '1.2.3' } }),
        ).toBeUndefined();
        expect(mocks.openReleaseNotes).toHaveBeenCalledOnce();

        expect(runToastAction({ id: 'diagnostics.revealExport' })).toBeUndefined();
        expect(mocks.request).toHaveBeenCalledWith('diagnostics.revealExport');

        expect(runToastAction({ id: 'caxriBot.open' })).toBeUndefined();
        expect(mocks.executeCommand).toHaveBeenCalledWith('caxriBot.open');
    });

    it('replays a parameterized follow-up with the data the notification recorded', () => {
        mocks.saveRetryUnavailableReason.mockReturnValue(undefined);

        expect(
            runToastAction({ id: 'session.unarchive', params: { sessionId: 'session-1' } }),
        ).toBeUndefined();
        // `unchanged` keeps Undo an exact inverse: the row returns to where it was archived from.
        expect(mocks.unarchiveSession).toHaveBeenCalledWith('session-1', 'unchanged');

        const save = { sessionId: 'session-1', tabId: 'tab-1', workbenchProjectId: 'project-1' };
        expect(runToastAction({ id: 'editor.retrySave', params: save })).toBeUndefined();
        expect(mocks.retrySaveDocument).toHaveBeenCalledWith(save);

        const create = { sessionId: 'session-1', kind: 'shell' } as const;
        expect(runToastAction({ id: 'terminal.create', params: create })).toBeUndefined();
        expect(mocks.createTerminalForSession).toHaveBeenCalledWith('session-1', 'shell', {
            cwd: undefined,
            paneId: undefined,
            split: undefined,
        });

        expect(
            runToastAction({ id: 'diagnostics.copyFailure', params: { text: 'EACCES' } }),
        ).toBeUndefined();
        expect(mocks.writeText).toHaveBeenCalledWith('EACCES');
    });

    it('refuses a Terminal restart once something else is running in that Terminal', () => {
        expect(
            runToastAction({
                id: 'terminal.restart',
                params: { terminalId: 'terminal-1', processId: TERMINAL.processId },
            }),
        ).toBeUndefined();
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith('terminal-1');

        // Somebody restarted it in the meantime; repeating the request would kill the process running now.
        expect(
            runToastAction({
                id: 'terminal.restart',
                params: { terminalId: 'terminal-1', processId: 1 },
            }),
        ).toBe('That Terminal has already been restarted.');
        expect(
            runToastAction({
                id: 'terminal.restart',
                params: { terminalId: 'gone', processId: 1 },
            }),
        ).toBe('That Terminal is no longer open.');
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledOnce();
    });

    it('refuses an Undo whose Session has moved on from the switch it takes back', () => {
        const parameters = {
            sessionId: 'session-1',
            projectId: 'project-owner',
            followedProjectId: 'project-followed',
        };

        expect(
            runToastAction({ id: 'workbench.undoFollowedRoot', params: parameters }),
        ).toBeUndefined();
        expect(mocks.undoFollowedWorkbenchRoot).toHaveBeenCalledWith('session-1', 'project-owner');

        // The snapshot only catches up to the followed root after this notice is raised, so the root the undo returns
        // to still counts as "that switch"; refusing here would kill the button for the seconds it is on screen.
        mocks.getBootstrap.mockReturnValue({
            sessions: [{ ...SESSION, workbenchProjectId: 'project-owner' }],
            terminals: [],
        });
        expect(
            runToastAction({ id: 'workbench.undoFollowedRoot', params: parameters }),
        ).toBeUndefined();

        mocks.getBootstrap.mockReturnValue({
            sessions: [{ ...SESSION, workbenchProjectId: 'project-chosen-later' }],
            terminals: [],
        });
        expect(runToastAction({ id: 'workbench.undoFollowedRoot', params: parameters })).toBe(
            'This Session has moved on from that switch.',
        );
        expect(mocks.undoFollowedWorkbenchRoot).toHaveBeenCalledTimes(2);
    });

    it('refuses every Session-scoped follow-up once the Session is gone', () => {
        mocks.getBootstrap.mockReturnValue({ sessions: [], terminals: [] });

        for (const action of [
            { id: 'session.unarchive', params: { sessionId: 'session-1' } },
            { id: 'terminal.create', params: { sessionId: 'session-1', kind: 'shell' } },
            {
                id: 'workbench.undoFollowedRoot',
                params: {
                    sessionId: 'session-1',
                    projectId: 'project-owner',
                    followedProjectId: 'project-followed',
                },
            },
        ] as const)
            expect(runToastAction(action)).toBe('That Session no longer exists.');

        expect(mocks.unarchiveSession).not.toHaveBeenCalled();
        expect(mocks.createTerminalForSession).not.toHaveBeenCalled();
        expect(mocks.undoFollowedWorkbenchRoot).not.toHaveBeenCalled();
    });

    it('answers for the failed save with the reason the editor gives', () => {
        mocks.saveRetryUnavailableReason.mockReturnValue('Save retry is no longer available.');

        expect(runToastAction({ id: 'editor.retrySave', params: { sessionId: 'session-1' } })).toBe(
            'Save retry is no longer available.',
        );
        expect(mocks.retrySaveDocument).not.toHaveBeenCalled();
    });

    it('declares a handler for every follow-up the catalog names', () => {
        expect(new Set(Object.keys(toastActionHandlers))).toEqual(
            new Set(Object.keys(toastActionLabelKeys)),
        );
    });
});
