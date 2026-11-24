import { createContext, useCallback, useContext, useMemo } from 'react';

import type { AgentChatItem } from '@caxri/protocol';
import { parseFileLocation } from '@caxri/protocol';

import { useLatestReference } from '@/hooks/use-latest-reference';

import { useIsLocalOnlyAvailable } from '../../../stores/environment';
import { openTerminalFileTarget } from '../../terminal/terminal-file-link-open';
import { revealTerminalFileTarget } from '../../terminal/terminal-file-link-reveal';
import { terminalPaneHost } from '../../terminal/terminal-pane-host';
import {
    agentChatCitedFileFallback,
    agentChatTouchedFilePaths,
} from '../references/agent-chat-cited-file';

const NO_ITEM_SOURCES: ReadonlyArray<readonly AgentChatItem[]> = [];

/**
 * Opens a file an Agent cites in `terminalId`'s Chat or one of its subagent tabs, resolved exactly like a path printed
 * in a Terminal: against the Projects that Terminal may reach, with the same candidate picker when several match. A
 * citation that resolves nowhere falls back to the one file of that name the conversation's own work touched
 * (`itemSources`: the loaded items, older pages included; a side chat has none of its own), so a file the Agent wrote
 * outside every Project and cited by name still opens. The returned callback stays stable while the items change.
 */
export function useAgentChatOpenFile(
    terminalId: string,
    itemSources: ReadonlyArray<readonly AgentChatItem[]> = NO_ITEM_SOURCES,
): (reference: string) => void {
    const latestItemSources = useLatestReference(itemSources);
    return useCallback(
        (reference: string) => {
            const { target, location } = parseFileLocation(reference);
            void openTerminalFileTarget(terminalId, target, location, {
                hasWorkbenchLinks: terminalPaneHost().hasWorkbenchLinks,
                fallbackTarget: () =>
                    agentChatCitedFileFallback(
                        target,
                        agentChatTouchedFilePaths(latestItemSources.current),
                    ),
            });
        },
        [latestItemSources, terminalId],
    );
}

/**
 * What this Mac can do with a file an Agent cites besides opening it in the editor: show it in Finder, and open an HTML
 * page in the browser.
 */
export interface AgentChatDesktopFileActions {
    reveal: (reference: string) => void;
    openInBrowser: (reference: string) => void;
}

/**
 * Builds {@link AgentChatDesktopFileActions} for files cited in `terminalId`'s Chat, resolved exactly as
 * {@link useAgentChatOpenFile} resolves them, falling back to the file of that name the conversation's own work touched.
 * `undefined` where neither can run: an SSH Host's Session, whose files live on another machine, and the Caxri Bot
 * window, whose Terminal links Main hands to the Workbench instead.
 */
export function useAgentChatDesktopFiles(
    terminalId: string,
    itemSources: ReadonlyArray<readonly AgentChatItem[]> = NO_ITEM_SOURCES,
): AgentChatDesktopFileActions | undefined {
    const latestItemSources = useLatestReference(itemSources);
    const isLocal = useIsLocalOnlyAvailable();
    const actions = useMemo(() => {
        const run = (reference: string, action: 'openInBrowser' | 'reveal') => {
            const { target } = parseFileLocation(reference);
            void revealTerminalFileTarget(terminalId, target, {
                action,
                fallbackTarget: () =>
                    agentChatCitedFileFallback(
                        target,
                        agentChatTouchedFilePaths(latestItemSources.current),
                    ),
            });
        };
        return {
            reveal: (reference: string) => run(reference, 'reveal'),
            openInBrowser: (reference: string) => run(reference, 'openInBrowser'),
        };
    }, [latestItemSources, terminalId]);
    return isLocal && terminalPaneHost().hasWorkbenchLinks ? actions : undefined;
}

/**
 * The desktop actions for files cited in a Chat timeline, provided where the timeline's open action is built. They
 * travel by context rather than beside `onOpenFile` through every row, because only the file links at the bottom of the
 * tree use them.
 */
export const AgentChatDesktopFilesContext = createContext<AgentChatDesktopFileActions | undefined>(
    undefined,
);

export function useAgentChatDesktopFileActions(): AgentChatDesktopFileActions | undefined {
    return useContext(AgentChatDesktopFilesContext);
}

/**
 * What a Chat timeline does with a cited file: `open` it in the editor, and the `desktop` actions where this Mac can
 * run them.
 */
export interface AgentChatFileLinks {
    open: (reference: string) => void;
    desktop: AgentChatDesktopFileActions | undefined;
}

/**
 * {@link useAgentChatOpenFile} and {@link useAgentChatDesktopFiles} together, for a timeline that hands both down.
 */
export function useAgentChatFileLinks(
    terminalId: string,
    itemSources: ReadonlyArray<readonly AgentChatItem[]>,
): AgentChatFileLinks {
    const open = useAgentChatOpenFile(terminalId, itemSources);
    const desktop = useAgentChatDesktopFiles(terminalId, itemSources);
    return useMemo(() => ({ open, desktop }), [open, desktop]);
}
