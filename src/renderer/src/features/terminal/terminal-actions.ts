import { addTerminal, splitTerminal } from '@shared/terminal-layout';
import type { TerminalKind, TerminalLayout } from '@shared/types';
import type { WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';
import { patchSessionState, refreshWorkbench } from '../../stores/workbench';
import { openTerminalSearch } from './terminal-search';
import { clearTerminalProgress } from './terminal-progress';

/** Drag payload type shared by the Terminal tab strip and the split-layout drop targets. */
export const TERMINAL_DRAG_TYPE = 'application/x-caxri-terminal';

export function activateTerminal(terminalId: string): void {
    useSessionViewStore.getState().activateWork({ kind: 'terminal', terminalId });
}

export async function createTerminal(
    kind: TerminalKind = 'shell',
    split = false,
    cwd?: string,
): Promise<void> {
    const session = getSelectedSession();
    if (!session) return;
    await tryCommand('Terminal creation failed', async () => {
        const terminal = await caxri.request('terminal.create', {
            sessionId: session.id,
            kind,
            ...(cwd ? { cwd } : {}),
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
        async () => {
            await caxri.request('terminal.close', { terminalId });
            clearTerminalProgress(terminalId);
        },
        {
            refresh: true,
        },
    );
}

async function requestTerminalRestart(terminalId: string, mode: 'resume' | 'fresh'): Promise<void> {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    /** A stopped PTY lost Runtime attachment ownership, while a running PTY must not be reattached
     *  because replaying its screen without a new xterm consumer would discard queued live output. */
    if (terminal?.lastProcessState !== 'running')
        await caxri.request('terminal.attach', { terminalId });
    await caxri.request('terminal.restart', { terminalId, mode });
}

/** Recovery path used by the in-pane Restart action. */
export function restartTerminal(terminalId: string): void {
    void tryCommand('Terminal restart failed', () => requestTerminalRestart(terminalId, 'resume'), {
        refresh: true,
    });
}

export function restartActiveTerminal(terminalId: string): void {
    void tryCommand('Terminal restart failed', () => requestTerminalRestart(terminalId, 'resume'), {
        refresh: true,
    });
}

/** The only user action allowed to clear a durable provider-session binding. */
export function startNewAgentSession(terminalId: string): void {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    if (!terminal?.provider || !terminal.agentSessionId) {
        pushToast('info', 'The active Terminal has no Agent session to replace.');
        return;
    }
    void tryCommand(
        'Starting a new Agent session failed',
        () => requestTerminalRestart(terminalId, 'fresh'),
        { refresh: true },
    );
}

/**
 * The mounted {@link TerminalPane} registers its clear handler here so `terminal.clear` can reach the
 * live xterm instance with a direct call instead of a window-wide `CustomEvent`. Only one pane owns a
 * given Terminal at a time, so a plain `Map` keyed by id is enough.
 */
const clearHandlers = new Map<string, () => void>();

export function registerTerminalClearHandler(terminalId: string, handler: () => void): () => void {
    clearHandlers.set(terminalId, handler);
    return () => {
        if (clearHandlers.get(terminalId) === handler) clearHandlers.delete(terminalId);
    };
}

export function clearActiveTerminal(terminalId: string): void {
    clearHandlers.get(terminalId)?.();
}

export function findInActiveTerminal(terminalId: string): void {
    openTerminalSearch(terminalId);
}

/**
 * Layout edits (drag, drop, splitter resize) clear `activeTab`; the drop handler re-activates the
 * moved Terminal right afterwards, and a resize leaves the layout's own active group in charge.
 */
export function applyTerminalLayout(layout: TerminalLayout): void {
    const current = getSessionState();
    if (current) patchSessionState({ ...current, activeTab: undefined, layout });
}
