import type { PaneNode } from '@caxri/protocol';

export interface PaneMount {
    key: string;
    pane: PaneNode;
    terminalId?: string;
}

/**
 * A visible Terminal owns its view even when a Root switch or split moves it into another pane. Match all surviving
 * Terminals first, then retain ordinary pane identities for tab navigation. Only current panes survive: this is not a
 * cache of hidden Terminal or Editor views.
 */
export function reconcilePaneMounts(
    previous: readonly PaneMount[],
    panes: readonly PaneNode[],
): PaneMount[] {
    const next = panes.map((pane) => {
        const tab = pane.tabs.find(({ id }) => id === pane.activeTabId) ?? pane.tabs.at(0);
        return {
            pane,
            terminalId: tab?.resource.kind === 'terminal' ? tab.resource.terminalId : undefined,
        };
    });
    const used = new Set<string>();
    const matches = next.map(({ terminalId }) => {
        const match = terminalId
            ? previous.find((entry) => entry.terminalId === terminalId)
            : undefined;
        if (match) used.add(match.key);
        return match;
    });
    return next.map((entry, index) => {
        const match =
            matches[index] ??
            previous.find(({ key, pane }) => pane.id === entry.pane.id && !used.has(key));
        let key = match?.key ?? `pane:${entry.pane.id}`;
        if (!match) {
            let suffix = 0;
            while (used.has(key)) key = `pane:${entry.pane.id}:${++suffix}`;
        }
        used.add(key);
        return { ...entry, key };
    });
}
