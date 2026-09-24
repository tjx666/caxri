import type { PaneLayout, TerminalRecord } from '@caxri/protocol';
import { listPaneTabs } from '@caxri/protocol';

/**
 * The Session a `Cmd+W` on this Terminal should archive: set only when the Terminal is both its Session's only Terminal
 * and the last open tab, so closing it would leave an empty Session row to clean up by hand. Archiving reaches that end
 * state in one keystroke, parks the Terminal instead of ending its process, and stays reversible through the notice's
 * Undo. A Session that still shows a document tab keeps the ordinary close.
 */
export function lastTabTerminalSessionId(
    terminals: ReadonlyArray<Pick<TerminalRecord, 'id' | 'sessionId'>>,
    layout: PaneLayout | undefined,
    terminalId: string,
): string | undefined {
    const sessionId = terminals.find((terminal) => terminal.id === terminalId)?.sessionId;
    if (!sessionId || !layout) return undefined;
    const isOnlyTab = listPaneTabs(layout).every(
        ({ tab }) => tab.resource.kind === 'terminal' && tab.resource.terminalId === terminalId,
    );
    const isOnlyTerminal = terminals.every(
        (terminal) => terminal.sessionId !== sessionId || terminal.id === terminalId,
    );
    return isOnlyTab && isOnlyTerminal ? sessionId : undefined;
}
