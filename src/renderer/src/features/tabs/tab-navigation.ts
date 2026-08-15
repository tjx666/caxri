import type { WorkItem } from '@shared/work-item';
import { areWorkItemsEqual } from '@shared/work-item';

import { getSelectedSession, getSessionState, getSessionTerminals } from '../../stores/selectors';
import { getResolvedActiveWork } from '../../stores/session-view';
import { selectEditorTab } from '../editor/document-actions';
import { activateTerminal } from '../terminal/terminal-actions';

/**
 * Same ordering `WorkTabStrip` renders: session Terminals first, then open editor tabs in
 * session-state order. Keeping this list in sync with the visual strip is what makes
 * `Ctrl+Tab`/`Ctrl+Shift+Tab` step exactly one visual tab position at a time.
 */
function orderedWorkItems(): WorkItem[] {
    const terminals = getSessionTerminals();
    const openTabs = getSessionState()?.openTabs ?? [];
    return [
        ...terminals.map((terminal): WorkItem => ({ kind: 'terminal', terminalId: terminal.id })),
        ...openTabs.map((tab): WorkItem => ({ kind: 'editor', path: tab.path })),
    ];
}

/**
 * Pure step function, exported separately so the wrap-around logic has focused unit coverage
 * without mocking the Renderer stores (see the `unit-testing` skill). When `active` is not present
 * in `items` — nothing focused yet — forward stepping lands
 * on the first tab and backward stepping lands on the last one, matching the usual "start of the
 * strip" expectation instead of an arbitrary offset.
 */
export function nextWorkItem(
    items: readonly WorkItem[],
    active: WorkItem | undefined,
    delta: 1 | -1,
): WorkItem | undefined {
    if (items.length === 0) return undefined;
    const currentIndex = items.findIndex((item) => areWorkItemsEqual(item, active));
    if (currentIndex === -1) return delta === 1 ? items[0] : items.at(-1);
    const nextIndex = (currentIndex + delta + items.length) % items.length;
    return items[nextIndex];
}

/**
 * Cycles the active work item across the whole tab strip (Terminals, then editor tabs) and wraps
 * around at either end. Backs the `workbench.nextTab` / `workbench.previousTab` commands
 * (`Ctrl+Tab` / `Ctrl+Shift+Tab`, both `allowInEditable`); see `commands/definitions.ts`.
 */
export function cycleActiveWork(delta: 1 | -1): void {
    if (!getSelectedSession()) return;
    const next = nextWorkItem(orderedWorkItems(), getResolvedActiveWork(), delta);
    if (!next) return;
    if (next.kind === 'terminal') activateTerminal(next.terminalId);
    else selectEditorTab(next.path);
}
