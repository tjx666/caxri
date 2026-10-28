import type { TerminalSurface } from '@caxri/protocol';
import { canUseAgentChat } from '@caxri/protocol';

import type { MobileTerminal } from './session-model';
import type { SessionSegment } from './session-ui-state';

/**
 * The surface "Open as ..." would reopen the Agent on, or `null` when it has no other one: a Shell, or an Agent whose
 * provider has no Chat integration. Mirrors Desktop's `canSwitchTerminalSurface`; the Server owns the authoritative
 * checks.
 */
export const agentSurfaceSwitchTarget = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider' | 'surface'> | undefined,
): TerminalSurface | null => {
    if (!terminal?.provider || !canUseAgentChat(terminal.kind)) return null;
    return terminal.surface === 'chat' ? 'pty' : 'chat';
};

/**
 * The tab that shows the Agent once it reopened on `surface`, so the switch lands where the user asked to go.
 */
export const segmentForAgentSurface = (surface: TerminalSurface): SessionSegment =>
    surface === 'chat' ? 'conversation' : 'terminal';
