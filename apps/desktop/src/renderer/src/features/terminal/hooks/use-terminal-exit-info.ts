import { useEffect, useSyncExternalStore } from 'react';

import type { ProcessState } from '@caxri/protocol';

import { caxri } from '../../../lib/caxri';
import type { TerminalExitInfo } from '../terminal-exit-info';
import {
    forgetTerminalProcessState,
    getTerminalExitInfo,
    noteTerminalProcessState,
    recordTerminalExit,
    subscribeTerminalExitInfo,
} from '../terminal-exit-info';

const subscription = { installed: false };

/**
 * One window-lifetime subscription feeds every Terminal's exit info; installed from an effect on the first mounted pane
 * (never during render) so a window without Terminals never listens. It stays for the window's life so an exit that
 * happens while its pane is unmounted (another tab) is still recorded.
 */
function ensureExitSubscription(): void {
    if (subscription.installed) return;
    subscription.installed = true;
    caxri.onEvent((event) => {
        if (event.event === 'terminal.exit') recordTerminalExit(event.payload);
    });
}

/**
 * The last exit code, signal, and run length for one Terminal, or undefined when this window did not see the exit.
 */
export function useTerminalExitInfo(
    terminalId: string,
    processState: ProcessState,
): TerminalExitInfo | undefined {
    useEffect(ensureExitSubscription, []);
    useEffect(() => {
        noteTerminalProcessState(terminalId, processState);
    }, [terminalId, processState]);
    useEffect(() => () => forgetTerminalProcessState(terminalId), [terminalId]);
    return useSyncExternalStore(subscribeTerminalExitInfo, () => getTerminalExitInfo(terminalId));
}
