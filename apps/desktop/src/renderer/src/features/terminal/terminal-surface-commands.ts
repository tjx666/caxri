import type { TerminalRecord, TerminalSurface } from '@caxri/protocol';
import {
    agentProviderCatalog,
    agentResumeCommandLine,
    canUseAgentChat,
    isChatTerminal,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import type { ContextMenuEntry } from '../../lib/context-menu';
import { readCommandShortcut } from '../../lib/keybindings';
import { getBootstrap } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import type { TerminalSurfaceSwitchRegistry } from './terminal-surface-switch-pending';
import { terminalSurfaceSwitches } from './terminal-surface-switch-pending';

const surfaceLabels: Record<TerminalSurface, string> = {
    chat: 'Open as Chat',
    pty: 'Open as Terminal',
};

type SurfaceSwitchTerminal = Pick<TerminalRecord, 'id' | 'kind' | 'provider' | 'surface'>;

/**
 * Whether the Terminal can reopen on the other surface: an Agent whose provider supports Chat (`canUseAgentChat`). A
 * Shell, or an Agent whose provider has no Chat integration, has no other surface. The Server owns the authoritative
 * checks.
 */
export function canSwitchTerminalSurface(
    terminal: Pick<TerminalRecord, 'kind' | 'provider'> | undefined,
): boolean {
    return Boolean(terminal?.provider && canUseAgentChat(terminal.kind));
}

/**
 * The surface a switch would open: Terminal for a Chat, Chat for a PTY.
 */
function otherTerminalSurface(terminal: Pick<TerminalRecord, 'surface'>): TerminalSurface {
    return isChatTerminal(terminal) ? 'pty' : 'chat';
}

/**
 * The tab-menu entry that reopens an Agent Terminal on the other surface, or `undefined` for a Terminal that cannot
 * switch. It shows the shortcut of `terminal.switchAgentSurface`, which performs the same switch on the active tab.
 */
export function terminalSurfaceMenuEntry(
    terminal: SurfaceSwitchTerminal,
): ContextMenuEntry | undefined {
    if (!canSwitchTerminalSurface(terminal)) return undefined;
    return {
        label: surfaceLabels[otherTerminalSurface(terminal)],
        shortcut: readCommandShortcut('terminal.switchAgentSurface'),
        onSelect: () => switchTerminalSurfaceTo(terminal, otherTerminalSurface(terminal)),
    };
}

/**
 * Reopens a Chat-capable Agent Terminal on `surface`; a Terminal already there, one that cannot switch, or one whose
 * previous switch is still pending is left alone. Every entry point (rail toggle, tab menu, shortcut, native menu)
 * comes through here, so the pending guard covers them all.
 */
export function switchTerminalSurfaceTo(
    terminal: SurfaceSwitchTerminal,
    surface: TerminalSurface,
    switches: TerminalSurfaceSwitchRegistry = terminalSurfaceSwitches,
): Promise<void> | undefined {
    const { provider } = terminal;
    if (!provider || !canSwitchTerminalSurface(terminal)) return undefined;
    if (otherTerminalSurface(terminal) !== surface) return undefined;
    return switches.run(terminal.id, surface, () =>
        switchTerminalSurface(terminal.id, surface, agentProviderCatalog[provider].displayName),
    );
}

/**
 * `terminal.switchAgentSurface`: reopens a Terminal on its other surface. The Workbench passes its active tab's
 * Terminal, the Agent Commander window its own Terminal.
 */
export function switchTerminalToOtherSurface(terminalId: string): void {
    const terminal = getBootstrap()?.terminals.find((candidate) => candidate.id === terminalId);
    // eslint-disable-next-line no-void -- intentional floating-promise discard, switchTerminalSurfaceTo reports its own errors
    if (terminal) void switchTerminalSurfaceTo(terminal, otherTerminalSurface(terminal));
}

/**
 * Reopens the Terminal on `surface`, continuing the same conversation, or starting one when there is none yet. A
 * running turn is never ended silently: the Server reports it, and only an explicit confirmation switches with
 * `interruptTurn`.
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

/**
 * "Copy Resume Command" for an Agent tab and a Session row (its Primary Agent): a shell command that continues the
 * bound Agent Session in the provider's own TUI outside Caxri. Disabled until the Agent has a conversation to continue;
 * `disabledReason` lets a menu reuse the wording of its other conversation entries.
 */
export function agentResumeCommandMenuEntry(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'cwd' | 'provider'> | undefined,
    disabledReason = 'Send a message first; there is no conversation to resume yet',
): ContextMenuEntry {
    const provider = terminal?.provider;
    const agentSessionId = terminal?.agentSessionId;
    return {
        label: 'Copy Resume Command',
        disabled: !provider || !agentSessionId,
        disabledReason,
        onSelect: () =>
            provider &&
            agentSessionId &&
            copyAgentResumeCommand(agentResumeCommandLine(provider, agentSessionId, terminal.cwd)),
    };
}

function copyAgentResumeCommand(command: string): Promise<unknown> {
    return tryCommand('Unable to copy the resume command', async () => {
        await navigator.clipboard.writeText(command);
        pushToast('success', 'Resume command copied');
    });
}
