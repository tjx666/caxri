import type { PaneLayout } from '@caxri/protocol';
import { addPaneTerminalSilently, listPaneTerminalIds, removePaneTerminal } from '@caxri/protocol';

/**
 * Terminal ownership is authoritative over a Renderer layout assembled earlier. Pruning prevents a stale write from
 * resurrecting a closed Terminal, while adding current omissions prevents the same write from hiding a Terminal created
 * after that snapshot was read.
 */
export function reconcileOwnedTerminalTabs(
    paneLayout: PaneLayout,
    terminalIds: readonly string[],
): PaneLayout {
    const owned = new Set(terminalIds);
    let reconciled = paneLayout;
    for (const terminalId of listPaneTerminalIds(reconciled))
        if (!owned.has(terminalId)) reconciled = removePaneTerminal(reconciled, terminalId);

    const visible = new Set(listPaneTerminalIds(reconciled));
    for (const terminalId of terminalIds) {
        if (visible.has(terminalId)) continue;
        const next = addPaneTerminalSilently(reconciled, terminalId);
        if (next !== reconciled) visible.add(terminalId);
        reconciled = next;
    }
    return reconciled;
}
