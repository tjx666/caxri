import type { ReactNode } from 'react';

import { MAX_PANE_LAYOUT_PANES } from '@caxri/protocol';
import type { PaneSplitSide } from '@shared/pane-layout';
import { paneSplitBlockedReason, paneTabIdsToClose } from '@shared/pane-layout';
import type { PaneLayout } from '@shared/types';

import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { closeDocumentTabFamily } from '../editor/document-actions';
import { splitPaneTab } from './pane-actions';

const closeLabels = {
    one: 'Close',
    others: 'Close Others',
    right: 'Close to the Right',
    all: 'Close All',
} as const;

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
 * Close and Split act on a tab's placement in the layout, never on the resource behind it — `closeDocumentTabs` already
 * ends a Terminal's process when it removes its tab — so a Terminal tab offering fewer of them than a document tab
 * beside it was a gap in the kind-neutral pane tree, not a deliberate restriction. Resource-specific entries (a
 * Terminal's "Move to New Session") are appended through `resourceItems` instead of branching in here.
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
    return (
        <ContextMenuContent>
            {(['one', 'others', 'right', 'all'] as const).map((mode) => {
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
