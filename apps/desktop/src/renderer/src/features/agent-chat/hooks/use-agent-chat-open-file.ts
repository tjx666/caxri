import { useCallback } from 'react';

import type { AgentChatItem } from '@caxri/protocol';
import { parseFileLocation } from '@caxri/protocol';

import { useLatestReference } from '@/hooks/use-latest-reference';

import { openTerminalFileTarget } from '../../terminal/terminal-file-link-open';
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
