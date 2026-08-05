import { addTerminal, splitTerminal } from '@shared/terminal-layout';
import type { TerminalKind, TerminalLayout } from '@shared/types';
import type { WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState } from '../../state/selectors';
import { useSessionViewStore } from '../../state/session-view';
import { tryCommand } from '../../state/toasts';
import { patchSessionState, refreshWorkbench } from '../../state/workbench';
import { clearTerminalView } from './terminal-view-commands';

export function activateTerminal(terminalId: string): void {
    useSessionViewStore.getState().activateWork({ kind: 'terminal', terminalId });
}

export async function createTerminal(kind: TerminalKind = 'shell', split = false): Promise<void> {
    const session = getSelectedSession();
    if (!session) return;
    await tryCommand('Terminal creation failed', async () => {
        const terminal = await caxri.request('terminal.create', {
            sessionId: session.id,
            kind,
        });
        const currentState = getSessionState();
        const item: WorkItem = { kind: 'terminal', terminalId: terminal.id };
        useSessionViewStore.getState().setActiveWork(session.id, item);
        if (currentState) {
            const layout =
                split && currentState.layout.activeGroupId
                    ? splitTerminal(
                          currentState.layout,
                          terminal.id,
                          currentState.layout.activeGroupId,
                          'horizontal',
                      )
                    : addTerminal(currentState.layout, terminal.id);
            patchSessionState({ ...currentState, activeTab: item, layout });
        }
        await refreshWorkbench();
    });
}

export function closeTerminal(terminalId: string): void {
    void tryCommand(
        'Terminal close failed',
        () => caxri.request('terminal.close', { terminalId }),
        {
            refresh: true,
        },
    );
}

/**
 * Recovery path used by the in-pane Restart action: a Terminal that died with the Runtime has no
 * attachment left, so it is re-attached before the restart to receive the new process output.
 */
export function restartTerminal(terminalId: string): void {
    void tryCommand(
        'Terminal restart failed',
        async () => {
            await caxri.request('terminal.attach', { terminalId });
            await caxri.request('terminal.restart', { terminalId });
        },
        { refresh: true },
    );
}

export function restartActiveTerminal(terminalId: string): void {
    void tryCommand(
        'Terminal restart failed',
        () => caxri.request('terminal.restart', { terminalId }),
        { refresh: true },
    );
}

export function clearActiveTerminal(terminalId: string): void {
    clearTerminalView(terminalId);
}

/**
 * Layout edits (drag, drop, splitter resize) clear `activeTab`; the drop handler re-activates the
 * moved Terminal right afterwards, and a resize leaves the layout's own active group in charge.
 */
export function applyTerminalLayout(layout: TerminalLayout): void {
    const current = getSessionState();
    if (current) patchSessionState({ ...current, activeTab: undefined, layout });
}
