import type { PaneLayout, PaneSplitSide, PaneTabCloseMode } from '@caxri/protocol';
import {
    findTab,
    MAX_PANE_LAYOUT_PANES,
    paneSplitBlockedReason,
    paneTabIdsToClose,
} from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { closeDocumentTabFamily } from '../editor/document-commands';
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
    'only-tab': 'Open another tab in this pane first',
    'pane-limit': `A Workbench holds at most ${MAX_PANE_LAYOUT_PANES} panes`,
} as const;

/**
 * The context menu every pane tab gets, whatever it holds.
 *
 * Bulk closes are scoped by `paneTabIdsToClose`, which never lets an editor action terminate a Terminal. Split acts on
 * placement across resource kinds. Resource-specific entries (a Terminal's "Move to New Session") are appended through
 * `resourceEntries`.
 *
 * `paneLayout` is the caller's reactive read rather than the imperative `getPaneLayout` other actions use: the builder
 * runs when the menu opens and reads the layout from the latest render, so "Close to the Right" and Split reflect tabs
 * opened or closed around this one.
 */
export function paneTabMenu({
    paneId,
    paneLayout,
    resourceEntries,
    tabId,
}: {
    paneId: string;
    paneLayout: PaneLayout | undefined;
    resourceEntries?: ContextMenuEntries;
    tabId: string;
}): ContextMenuEntries {
    const splitBlockedReason = paneLayout
        ? paneSplitBlockedReason(paneLayout, tabId, paneId)
        : 'missing';
    const isTerminalTab =
        paneLayout && findTab(paneLayout, tabId)?.tab.resource.kind === 'terminal';
    return [
        ...(isTerminalTab ? terminalCloseModes : documentCloseModes).map((mode) => ({
            label: closeLabels[mode],
            disabled: (paneLayout ? paneTabIdsToClose(paneLayout, tabId, mode) : []).length === 0,
            onSelect: () => closeDocumentTabFamily(tabId, mode),
        })),
        CONTEXT_MENU_SEPARATOR,
        ...(['left', 'right', 'up', 'down'] as const).map((side) => ({
            label: splitLabels[side],
            disabled: splitBlockedReason !== undefined,
            disabledReason: splitBlockedReason && splitDisabledReasons[splitBlockedReason],
            onSelect: () => splitPaneTab(tabId, paneId, side),
        })),
        ...(resourceEntries ? [CONTEXT_MENU_SEPARATOR, ...resourceEntries] : []),
    ];
}
