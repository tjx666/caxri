import type { CommandId, PaneLayout, PaneSplitSide, PaneTabCloseMode } from '@caxri/protocol';
import {
    findTab,
    MAX_PANE_LAYOUT_PANES,
    paneSplitBlockedReason,
    paneTabIdsToClose,
} from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { readCommandShortcut } from '../../lib/keybindings';
import { closeDocumentTabFamily } from '../editor/document-commands';
import { splitPaneTab } from './pane-actions';

/**
 * The close modes a keyboard command also performs, so their entries can show its shortcut as VS Code's tab menu does.
 */
const closeCommands: Partial<Record<PaneTabCloseMode, CommandId>> = {
    one: 'workbench.closeActiveTab',
    others: 'workbench.closeOtherTabs',
};

const closeLabelKeys: Record<PaneTabCloseMode, TranslationKey> = {
    one: 'workbench.tabMenu.close.one',
    others: 'workbench.tabMenu.close.others',
    right: 'workbench.tabMenu.close.right',
    editors: 'workbench.tabMenu.close.editors',
    all: 'workbench.tabMenu.close.all',
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

const splitLabelKeys: Record<PaneSplitSide, TranslationKey> = {
    left: 'workbench.tabMenu.split.left',
    right: 'workbench.tabMenu.split.right',
    up: 'workbench.tabMenu.split.up',
    down: 'workbench.tabMenu.split.down',
};

const splitDisabledReasonKeys = {
    'missing': 'workbench.tabMenu.splitBlocked.missing',
    'only-tab': 'workbench.tabMenu.splitBlocked.onlyTab',
    'pane-limit': 'workbench.tabMenu.splitBlocked.paneLimit',
} as const satisfies Record<string, TranslationKey>;

/**
 * The context menu every pane tab gets, whatever it holds.
 *
 * Bulk closes are scoped by `paneTabIdsToClose`, which never lets an editor action terminate a Terminal. Split acts on
 * placement across resource kinds. Resource-specific entries (a Terminal's "Move to New Session") are appended through
 * `resourceEntries`.
 *
 * `paneLayout` is the caller's reactive read rather than the imperative `getPaneLayout` other actions use: the builder
 * runs when the menu opens and reads the layout from the latest render, so "Close to the Right" and Split reflect tabs
 * opened or closed around this one. Labels are translated here, when the menu opens, so they follow the current
 * language.
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
            label: translate(closeLabelKeys[mode]),
            shortcut: closeCommands[mode] && readCommandShortcut(closeCommands[mode]),
            disabled: (paneLayout ? paneTabIdsToClose(paneLayout, tabId, mode) : []).length === 0,
            onSelect: () => closeDocumentTabFamily(tabId, mode),
        })),
        CONTEXT_MENU_SEPARATOR,
        ...(['left', 'right', 'up', 'down'] as const).map((side) => ({
            label: translate(splitLabelKeys[side]),
            disabled: splitBlockedReason !== undefined,
            disabledReason:
                splitBlockedReason &&
                translate(splitDisabledReasonKeys[splitBlockedReason], {
                    count: MAX_PANE_LAYOUT_PANES,
                }),
            onSelect: () => splitPaneTab(tabId, paneId, side),
        })),
        ...(resourceEntries ? [CONTEXT_MENU_SEPARATOR, ...resourceEntries] : []),
    ];
}
