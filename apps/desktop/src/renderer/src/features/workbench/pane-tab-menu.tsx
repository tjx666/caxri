import type { ReactNode } from 'react';

import type { PaneLayout, PaneSplitSide, PaneTabCloseMode } from '@caxri/protocol';
import {
    findTab,
    MAX_PANE_LAYOUT_PANES,
    paneSplitBlockedReason,
    paneTabIdsToClose,
} from '@caxri/protocol';

import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { closeDocumentTabFamily } from '../editor/document-actions';
import { splitPaneTab } from './pane-actions';

const closeLabels: Record<PaneTabCloseMode, string> = {
    one: 'Close',
    others: 'Close Others',
    right: 'Close to the Right',
    editors: 'Close Editors',
    all: 'Close All',
};

/**
 * "Close Editors" is offered only on a Terminal tab. From a document it would be an alias for "Close All" one line
 * above it, whereas a Terminal is exactly the tab a user keeps while clearing the documents stacked next to it.
 */
const terminalCloseModes: readonly PaneTabCloseMode[] = [
    'one',
    'others',
    'right',
    'editors',
    'all',
];
const documentCloseModes: readonly PaneTabCloseMode[] = ['one', 'others', 'right', 'all'];

const splitLabels: Record<PaneSplitSide, string> = {
    left: 'Split Left',
    right: 'Split Right',
    up: 'Split Up',
    down: 'Split Down',
};

const splitDisabledReasons = {
    'missing': 'This tab is no longer open',
    'only-tab': 'This pane has only this tab, so splitting it would just move the pane',
    'pane-limit': `A Workbench holds at most ${MAX_PANE_LAYOUT_PANES} panes`,
} as const;

/**
 * The context menu every pane tab gets, whatever it holds.
 *
 * Bulk closes are scoped by `paneTabIdsToClose`, which never lets an editor action terminate a Terminal. Split acts on
 * placement across resource kinds. Resource-specific entries (a Terminal's "Move to New Session") are appended through
 * `resourceItems`.
 */
export function PaneTabMenu({
    paneId,
    paneLayout,
    resourceItems,
    tabId,
}: {
    paneId: string;
    /**
     * Read reactively by the caller (not through the imperative `getPaneLayout` other actions use): an on-demand store
     * read inside this JSX tree does not reliably reflect the latest layout once other tabs open or close around it,
     * leaving "Close to the Right" and Split stuck at a stale disabled state.
     */
    paneLayout: PaneLayout | undefined;
    resourceItems?: ReactNode;
    tabId: string;
}) {
    const splitBlockedReason = paneLayout
        ? paneSplitBlockedReason(paneLayout, tabId, paneId)
        : 'missing';
    const isTerminalTab =
        paneLayout && findTab(paneLayout, tabId)?.tab.resource.kind === 'terminal';
    return (
        <ContextMenuContent>
            {(isTerminalTab ? terminalCloseModes : documentCloseModes).map((mode) => {
                const family = paneLayout ? paneTabIdsToClose(paneLayout, tabId, mode) : [];
                return (
                    <ContextMenuItem
                        key={mode}
                        disabled={family.length === 0}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, closeDocumentTabFamily() reports its own errors
                            void closeDocumentTabFamily(tabId, mode);
                        }}
                    >
                        {closeLabels[mode]}
                    </ContextMenuItem>
                );
            })}
            <ContextMenuSeparator />
            {(['left', 'right', 'up', 'down'] as const).map((side) => (
                <ContextMenuItem
                    key={side}
                    disabled={splitBlockedReason !== undefined}
                    disabledReason={splitBlockedReason && splitDisabledReasons[splitBlockedReason]}
                    onClick={() => splitPaneTab(tabId, paneId, side)}
                >
                    {splitLabels[side]}
                </ContextMenuItem>
            ))}
            {resourceItems && (
                <>
                    <ContextMenuSeparator />
                    {resourceItems}
                </>
            )}
        </ContextMenuContent>
    );
}
