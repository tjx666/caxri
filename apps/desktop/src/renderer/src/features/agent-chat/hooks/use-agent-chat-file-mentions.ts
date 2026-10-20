import { listPaneTabs } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '../../../hooks/use-debounced-value';
import { caxri } from '../../../lib/caxri';
import { getSelectedSession, getSessionState } from '../../../stores/selectors';
import {
    MAX_AGENT_CHAT_FILE_MENTIONS,
    openFileMentions,
    rankAgentChatFileMentions,
} from '../composer-input/agent-chat-file-mentions';

const NO_FILES: readonly string[] = [];
/**
 * Name-search results are keyed per Session; a keystroke abandons the previous request (see `requestWithSignal`).
 */
const SEARCH_DEBOUNCE_MS = 120;

/**
 * Project-relative paths of the files in open Editor tabs of the selected Session, for an empty `@`.
 */
function openEditorFilePaths(sessionId: string): string[] {
    if (getSelectedSession()?.id !== sessionId) return [];
    const layout = getSessionState()?.paneLayout;
    if (!layout) return [];
    return listPaneTabs(layout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' ? [tab.resource.path] : [],
    );
}

/**
 * The `Files` group of the Chat composer's `@` list: Project files whose path contains the typed word, from the same
 * bounded Server Core `files.search` name scan quick open uses (so authorization against the Session's Project root,
 * ignore rules, and workspace links are already applied; Chat adds no second file index). An empty query lists the
 * files open in Editor tabs. Returns Project-relative paths, best match first, and whether a search is still running.
 */
export function useAgentChatFileMentions({
    isEnabled,
    query,
    root,
    sessionId,
}: {
    /**
     * Whether the list could be showing; no search runs otherwise.
     */
    isEnabled: boolean;
    query: string;
    /**
     * Where the Agent runs, to turn open tabs' absolute paths into Project-relative ones.
     */
    root: string | undefined;
    sessionId: string | undefined;
}): { files: readonly string[]; isSearching: boolean } {
    const word = query.trim();
    const debounced = useDebouncedValue(word, SEARCH_DEBOUNCE_MS);
    const isSearchEnabled = isEnabled && sessionId !== undefined && debounced.length > 0;
    const result = useQuery({
        queryKey: ['files.search', 'agent-chat-mention', sessionId, debounced],
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('files.search', signal, {
                sessionId: sessionId!,
                consumer: 'agent-chat-mention',
                mode: 'name',
                query: debounced,
            }),
        enabled: isSearchEnabled,
        placeholderData: keepPreviousData,
        staleTime: 5000,
    });
    if (!isEnabled || sessionId === undefined) return { files: NO_FILES, isSearching: false };
    if (word.length === 0)
        return {
            files: openFileMentions(openEditorFilePaths(sessionId), root),
            isSearching: false,
        };
    // The previous word's hits stay on screen while the next search runs; only those that still contain the word do.
    const needle = word.toLowerCase();
    const paths = result.data
        ? rankAgentChatFileMentions(
              result.data.matches
                  .map((match) => match.relativePath)
                  .filter((path) => path.toLowerCase().includes(needle)),
              word,
              MAX_AGENT_CHAT_FILE_MENTIONS,
          )
        : NO_FILES;
    return { files: paths, isSearching: debounced !== word || result.isFetching };
}
