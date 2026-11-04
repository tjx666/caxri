import { createContext, useCallback, useContext } from 'react';

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
 * Shows a file an Agent cites in Finder, resolved exactly as {@link useAgentChatOpenFile} resolves it, falling back to
 * the file of that name the conversation's own work touched. `undefined` where Finder cannot show it: an SSH Host's
 * Session, whose files live on another machine, and the Caxri Bot window, whose Terminal links Main hands to the
 * Workbench instead.
 */
export function useAgentChatRevealFile(
    terminalId: string,
    itemSources: ReadonlyArray<readonly AgentChatItem[]> = NO_ITEM_SOURCES,
): ((reference: string) => void) | undefined {
    const latestItemSources = useLatestReference(itemSources);
    const isLocal = useIsLocalOnlyAvailable();
    const reveal = useCallback(
        (reference: string) => {
            const { target } = parseFileLocation(reference);
            void revealTerminalFileTarget(terminalId, target, {
                fallbackTarget: () =>
                    agentChatCitedFileFallback(
                        target,
                        agentChatTouchedFilePaths(latestItemSources.current),
                    ),
            });
        },
        [latestItemSources, terminalId],
    );
    return isLocal && terminalPaneHost().hasWorkbenchLinks ? reveal : undefined;
}

/**
 * The Reveal in Finder action for files cited in a Chat timeline, provided where the timeline's open action is built.
 * It travels by context rather than beside `onOpenFile` through every row, because only the Markdown renderer at the
 * bottom of the tree uses it.
 */
export const AgentChatRevealFileContext = createContext<((reference: string) => void) | undefined>(
    undefined,
);

export function useAgentChatRevealFileAction(): ((reference: string) => void) | undefined {
    return useContext(AgentChatRevealFileContext);
}
