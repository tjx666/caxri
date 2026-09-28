import type { TerminalResourceAlert } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    bootstrap: { terminals: [{ id: 'terminal-1', processId: 100 }] },
    dismissToastsMatching: vi.fn(
        (shouldDismiss: (title: string) => boolean): unknown => shouldDismiss,
    ),
    pushToast: vi.fn(),
    stopTerminal: vi.fn(),
}));

vi.mock('../../../stores/selectors', () => ({ getBootstrap: () => mocks.bootstrap }));
vi.mock('../../../stores/toasts', () => ({
    dismissToastsMatching: mocks.dismissToastsMatching,
    pushToast: mocks.pushToast,
}));
vi.mock('../terminal-commands', () => ({
    refreshTerminalState: vi.fn(),
    restartTerminalWithRecovery: vi.fn(),
    stopTerminal: mocks.stopTerminal,
}));

import {
    reportTerminalResourceAlert,
    terminalResourceAlertMessage,
} from '../terminal-resource-alerts';
import { terminalToastActionHandlers } from '../terminal-toast-actions';

const raised: TerminalResourceAlert = {
    state: 'raised',
    terminal: {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        sessionTitle: 'Tune the timeline',
        kind: 'claude',
        provider: 'claude',
        title: 'Claude Code',
        processId: 100,
    },
    cpuPercent: 396.2,
    memoryMb: 4_505.6,
    processCount: 19,
};

function dismissedMessages(): string[] {
    return mocks.dismissToastsMatching.mock.calls
        .map(([shouldDismiss]) => shouldDismiss)
        .flatMap((shouldDismiss) =>
            [terminalResourceAlertMessage(raised)].filter((message) => shouldDismiss(message)),
        );
}

describe('terminal resource alerts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('names the Agent, the Session, and both readings', () => {
        expect(terminalResourceAlertMessage(raised)).toBe(
            'High resource use: Claude Code · Tune the timeline is using 4.4 GB of memory and 396% CPU.',
        );
    });

    it('persists a raised alert with View details and Stop, and retracts it once cleared', () => {
        reportTerminalResourceAlert(raised);
        expect(mocks.pushToast.mock.calls[0]).toMatchObject([
            'warning',
            terminalResourceAlertMessage(raised),
            {
                persist: true,
                secondaryAction: { id: 'processExplorer.open' },
                action: {
                    id: 'terminal.stopRunaway',
                    params: { terminalId: 'terminal-1', processId: 100 },
                },
            },
        ]);
        mocks.dismissToastsMatching.mockClear();
        reportTerminalResourceAlert({ ...raised, state: 'cleared' });
        expect(dismissedMessages()).toEqual([terminalResourceAlertMessage(raised)]);
    });

    it('stops the Terminal on Stop and refuses once its process changed', () => {
        const handler = terminalToastActionHandlers['terminal.stopRunaway'];
        expect(handler.unavailable?.({ terminalId: 'terminal-1', processId: 100 })).toBeUndefined();
        expect(handler.unavailable?.({ terminalId: 'terminal-1', processId: 200 })).toMatch(
            /no longer running/,
        );
        expect(handler.unavailable?.({ terminalId: 'missing', processId: 100 })).toMatch(
            /no longer open/,
        );
        handler.run({ terminalId: 'terminal-1', processId: 100 });
        expect(mocks.stopTerminal).toHaveBeenCalledWith('terminal-1');
    });
});
