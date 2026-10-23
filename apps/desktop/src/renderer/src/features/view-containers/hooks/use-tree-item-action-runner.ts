import { useState } from 'react';

import type { TreeItemAction } from '../tree-item-actions';
import { runTreeItemAction } from '../tree-item-actions';

const NO_RUNNING_ACTIONS: ReadonlySet<string> = new Set();

/**
 * Runs one row's inline actions, whether the button or the row's context menu started them. The running set is shared
 * by both, so an action still waiting on its confirmation or its command cannot be started a second time from the other
 * entry point: the button shows it as busy and the menu entry as disabled.
 */
export function useTreeItemActionRunner(): {
    /**
     * Command ids of the actions this row is running.
     */
    runningCommandIds: ReadonlySet<string>;
    runAction: (action: TreeItemAction) => void;
} {
    const [runningCommandIds, setRunningCommandIds] = useState(NO_RUNNING_ACTIONS);
    const runAction = (action: TreeItemAction): void => {
        const { id } = action.command;
        if (runningCommandIds.has(id)) return;
        setRunningCommandIds((current) => new Set(current).add(id));
        void runTreeItemAction(action).finally(() =>
            setRunningCommandIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            }),
        );
    };
    return { runningCommandIds, runAction };
}
