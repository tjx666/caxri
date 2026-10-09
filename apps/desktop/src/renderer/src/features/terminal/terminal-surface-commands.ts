import type { TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { agentProviderCatalog, canUseAgentChat, isChatTerminal } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import type { ContextMenuEntry } from '../../lib/context-menu';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

const surfaceLabels: Record<TerminalSurface, string> = {
    chat: 'Open as Chat',
    pty: 'Open as Terminal',
};

/**
 * The tab-menu entry that reopens an Agent Terminal on the other surface, or `undefined` for a Terminal that cannot
 * switch (a Shell, or an Agent without Chat support). The Server owns the authoritative checks; disabling an unbound
 * Agent here only explains up front why there is nothing to carry over yet.
 */
export function terminalSurfaceMenuEntry(terminal: TerminalRecord): ContextMenuEntry | undefined {
    const { provider } = terminal;
    if (!provider || !canUseAgentChat(terminal.kind)) return undefined;
    const target: TerminalSurface = isChatTerminal(terminal) ? 'pty' : 'chat';
    return {
        label: surfaceLabels[target],
        disabled: !terminal.agentSessionId,
        disabledReason: 'Send a message first; there is no conversation to continue yet',
        onSelect: () =>
            switchTerminalSurface(terminal.id, target, agentProviderCatalog[provider].displayName),
    };
}

/**
 * Reopens the Terminal on `surface`, continuing the same conversation. A running turn is never ended silently: the
 * Server reports it, and only an explicit confirmation switches with `interruptTurn`.
 */
export async function switchTerminalSurface(
    terminalId: string,
    surface: TerminalSurface,
    providerName: string,
): Promise<void> {
    await tryCommand(
        `${surfaceLabels[surface]} failed`,
        async () => {
            const result = await caxri.request('terminal.switchSurface', { terminalId, surface });
            if (result.status === 'switched') return;
            const isConfirmed = await caxri.window.showConfirm({
                title: 'Stop the running turn?',
                message: `${providerName} is still working. Switching stops the current turn and continues the conversation ${surface === 'chat' ? 'in Chat' : 'in the Terminal'}.`,
                confirmLabel: 'Stop and Switch',
            });
            if (!isConfirmed) return;
            await caxri.request('terminal.switchSurface', {
                terminalId,
                surface,
                interruptTurn: true,
            });
        },
        { refresh: refreshWorkbench },
    );
}
