import { activePane } from '@caxri/protocol';

import { getSelectedSession } from '../../stores/selectors';
import { getPaneLayout, selectPaneTab } from '../workbench/pane-actions';

/**
 * Pure step function, exported separately so the wrap-around logic has focused unit coverage without mocking the
 * Renderer stores (see the `unit-testing` skill). When `activeId` is not present in `ids` (nothing focused yet) forward
 * stepping lands on the first tab and backward stepping lands on the last one, matching the usual "start of the strip"
 * expectation instead of an arbitrary offset.
 */
export function nextTabId(
    ids: readonly string[],
    activeId: string | undefined,
    delta: 1 | -1,
): string | undefined {
    if (ids.length === 0) return undefined;
    const currentIndex = ids.indexOf(activeId ?? '');
    if (currentIndex === -1) return delta === 1 ? ids[0] : ids.at(-1);
    return ids[(currentIndex + delta + ids.length) % ids.length];
}

/**
 * Cycles the active tab within the focused pane and wraps around at either end. Backs the `workbench.nextTab` /
 * `workbench.previousTab` commands (`Ctrl+Tab` / `Ctrl+Shift+Tab`, both `allowInEditable`); see
 * `commands/definitions.ts`. Cycling stays inside one pane because that is the bar the user is looking at: moving
 * between panes is a separate command.
 */
export function cycleActiveTab(delta: 1 | -1): void {
    const layout = getPaneLayout();
    if (!layout || !getSelectedSession()) return;
    const pane = activePane(layout);
    const tabIds = pane.tabs.map((tab) => tab.id);
    const next = nextTabId(tabIds, pane.activeTabId ?? tabIds[0], delta);
    if (next) selectPaneTab(next);
}
