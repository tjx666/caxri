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

import { runToastAction, unknownToastActionReason } from '../../../stores/toast-actions';
import { configureBotToastActions } from '../bot-toast-actions';

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getBootstrap.mockReturnValue({
        sessions: [],
        terminals: [{ id: 'bot-terminal', processId: 42 }],
    });
    configureBotToastActions();
});

describe('Caxri Bot toast actions', () => {
    it("retries a failed Caxri Bot's Terminal restart from its notification", () => {
        expect(
            runToastAction({
                id: 'terminal.restart',
                params: { processId: 42, terminalId: 'bot-terminal' },
            }),
        ).toBeUndefined();
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith('bot-terminal');
    });

    it("refreshes Caxri Bot's Terminal from its notification", () => {
        expect(runToastAction({ id: 'terminal.refresh' })).toBeUndefined();
        expect(mocks.refreshTerminalState).toHaveBeenCalledOnce();
    });

    it('opens Settings in the Workbench from the software-rendering notification', () => {
        mocks.request.mockResolvedValue(undefined);

        expect(runToastAction({ id: 'settings.openHardwareAcceleration' })).toBeUndefined();
        expect(mocks.request).toHaveBeenCalledWith('caxriBot.openSettings');
    });

    it('refuses a follow-up only the Workbench window can run', () => {
        expect(runToastAction({ id: 'settings.open' })).toBe(unknownToastActionReason());
    });
});
