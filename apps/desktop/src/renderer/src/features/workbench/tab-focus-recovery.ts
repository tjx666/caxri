import type { PaneLayout } from '@caxri/protocol';
import { activePane } from '@caxri/protocol';

/**
 * Where keyboard focus last sat inside the panes before it fell back to `document.body`.
 *
 * - `tab-bar`: on a work tab, i.e. the user was navigating tabs.
 * - `content`: anywhere else inside a pane: xterm's helper textarea, Monaco, the bar's "+" button.
 * - `none`: outside the panes entirely (sidebar, Settings), which no recovery should touch.
 */
export type PaneFocusOrigin = 'content' | 'none' | 'tab-bar';

export interface TabFocusRecoveryTarget {
    paneId: string;
    /**
     * Whether the tab button must be marked `preserveTerminalFocus` so the activated Terminal leaves WAI-ARIA tab focus
     * alone. Only a tab-bar origin earns this: the user was navigating tabs and should keep doing so.
     */
    preserveTerminalFocus: boolean;
    tabId: string;
}

/**
 * Decides which tab button, if any, should receive focus after a layout edit left nothing focused.
 *
 * A Terminal that becomes active while focus was in pane content claims focus itself once its PTY is running
 * (`reconcileTerminalProcessFocus`). Handing focus to its tab button in the meantime would carry the
 * `preserveTerminalFocus` marker for that very Terminal and veto its own auto-focus, which is how `Cmd+T` and the "+"
 * button ended up leaving a freshly created Terminal unfocused, with a keyboard focus ring painted on the tab that no
 * keyboard action produced. The tab bar stays the recovery target only when the lost focus started there.
 */
export function planTabFocusRecovery(
    layout: PaneLayout | undefined,
    origin: PaneFocusOrigin,
): TabFocusRecoveryTarget | undefined {
    if (!layout || origin === 'none') return undefined;
    const pane = activePane(layout);
    const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
    if (!tab) return undefined;
    const isTerminal = tab.resource.kind === 'terminal';
    if (isTerminal && origin === 'content') return undefined;
    return { paneId: pane.id, preserveTerminalFocus: isTerminal, tabId: tab.id };
}
