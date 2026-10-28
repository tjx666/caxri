import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    dismissToastsMatching: vi.fn(
        (shouldDismiss: (title: string) => boolean): unknown => shouldDismiss,
    ),
    pushToast: vi.fn(),
}));

vi.mock('../../../stores/toasts', () => ({
    dismissToastsMatching: mocks.dismissToastsMatching,
    pushToast: mocks.pushToast,
}));

import { useEnvironmentStore } from '../../../stores/environment';
import { reportTerminalPtyAlert, terminalPtyAlertMessage } from '../terminal-pty-alerts';

const raised = { state: 'raised', inUse: 420, limit: 511 } as const;

function wasDismissed(message: string): boolean {
    return mocks.dismissToastsMatching.mock.calls.some(([shouldDismiss]) => shouldDismiss(message));
}

describe('terminal PTY alerts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useEnvironmentStore.setState({ state: { kind: 'local' } });
        reportTerminalPtyAlert({ ...raised, state: 'cleared' });
        vi.clearAllMocks();
    });

    it('names both readings', () => {
        expect(terminalPtyAlertMessage(raised)).toBe(
            'Almost out of terminal slots (PTYs): 420 of 511 in use. Close Terminals you no longer need, or new ones will fail to start.',
        );
    });

    it('keeps a persistent warning that opens Process Explorer', () => {
        reportTerminalPtyAlert(raised);

        expect(mocks.pushToast).toHaveBeenCalledWith('warning', terminalPtyAlertMessage(raised), {
            persist: true,
            action: { id: 'processExplorer.open' },
        });
    });

    it('retracts the raised notice when use falls back', () => {
        reportTerminalPtyAlert(raised);
        reportTerminalPtyAlert({ state: 'cleared', inUse: 300, limit: 511 });

        expect(mocks.pushToast).toHaveBeenCalledTimes(1);
        expect(wasDismissed(terminalPtyAlertMessage(raised))).toBe(true);
    });

    it('leaves out View details in an SSH Host window, whose processes Process Explorer cannot see', () => {
        useEnvironmentStore.setState({
            state: {
                kind: 'ssh',
                destination: 'devbox',
                hostIdentity: 'devbox',
                phase: 'connected',
                needsUserAction: false,
            },
        });
        reportTerminalPtyAlert(raised);

        expect(mocks.pushToast.mock.calls[0]?.[2]).toMatchObject({ action: undefined });
    });
});
