import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getBootstrap: vi.fn(),
    request: vi.fn(),
    refreshTerminalState: vi.fn(),
    restartTerminalWithRecovery: vi.fn(),
}));

vi.mock('../../terminal/terminal-commands', () => ({
    refreshTerminalState: mocks.refreshTerminalState,
    restartTerminalWithRecovery: mocks.restartTerminalWithRecovery,
}));
vi.mock('../../../stores/selectors', () => ({ getBootstrap: mocks.getBootstrap }));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { runToastAction, UNKNOWN_TOAST_ACTION_REASON } from '../../../stores/toast-actions';
import { configureCommanderToastActions } from '../commander-toast-actions';

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getBootstrap.mockReturnValue({
        sessions: [],
        terminals: [{ id: 'commander-terminal', processId: 42 }],
    });
    configureCommanderToastActions();
});

describe('Agent Commander toast actions', () => {
    it('retries a failed Commander Terminal restart from its notification', () => {
        expect(
            runToastAction({
                id: 'terminal.restart',
                params: { processId: 42, terminalId: 'commander-terminal' },
            }),
        ).toBeUndefined();
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith('commander-terminal');
    });

    it('refreshes the Commander Terminal from its notification', () => {
        expect(runToastAction({ id: 'terminal.refresh' })).toBeUndefined();
        expect(mocks.refreshTerminalState).toHaveBeenCalledOnce();
    });

    it('opens Settings in the Workbench from the software-rendering notification', () => {
        mocks.request.mockResolvedValue(undefined);

        expect(runToastAction({ id: 'settings.openHardwareAcceleration' })).toBeUndefined();
        expect(mocks.request).toHaveBeenCalledWith('agentCommander.openSettings');
    });

    it('refuses a follow-up only the Workbench window can run', () => {
        expect(runToastAction({ id: 'settings.open' })).toBe(UNKNOWN_TOAST_ACTION_REASON);
    });
});
