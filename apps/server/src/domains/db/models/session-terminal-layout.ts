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

/**
 * Picks the arrangement a Session-state write should persist.
 *
 * A write that never mentions a Terminal the Server already owns was assembled before that Terminal existed, so its
 * pane tree also predates whatever pane the Server built for it. Merging such a write used to flatten a Server-created
 * pane (an Agent delegation's sibling pane, for example) back into a background tab of the caller's pane, and the split
 * was then gone for good, including across a restart. The stored arrangement is newer for exactly that case, so it
 * wins; the write's answer carries it back and the Renderer adopts it instead of its own stale copy.
 *
 * Every other write still reconciles normally, including one that omits a Terminal the stored arrangement never placed
 * either: there the incoming layout is the only arrangement anyone has.
 */
export function resolveSessionPaneLayout(
    incoming: PaneLayout,
    stored: PaneLayout | undefined,
    terminalIds: readonly string[],
): PaneLayout {
    const written = new Set(listPaneTerminalIds(incoming));
    const missing = terminalIds.filter((terminalId) => !written.has(terminalId));
    if (stored && missing.length > 0) {
        const placed = new Set(listPaneTerminalIds(stored));
        if (missing.every((terminalId) => placed.has(terminalId)))
            return reconcileOwnedTerminalTabs(stored, terminalIds);
    }
    return reconcileOwnedTerminalTabs(incoming, terminalIds);
}
