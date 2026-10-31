import { createContext, useCallback, useContext, useMemo } from 'react';

import type { AgentChatSnapshot, AgentChatVersionContent } from '@caxri/protocol';
import { useQueries, useQuery } from '@tanstack/react-query';

import {
    selectAgentChatVersionSelection,
    showCurrentAgentChatVersion,
    stepAgentChatVersion,
    useAgentChatVersionSelectionStore,
} from './agent-chat-version-selection';
import type { AgentChatVersionSwitcher } from './agent-chat-versions';
import {
    agentChatSnapshotWithVersions,
    agentChatVersionGroups,
    agentChatVersionView,
} from './agent-chat-versions';
import { agentChatVersionQuery, agentChatVersionsQuery } from './agent-chat-versions-client';

/**
 * What a Chat's user messages read to show the version switcher, and its other surfaces to tell an earlier version on
 * screen from the current one. Provided by the Chat pane; a read-only task timeline provides none.
 */
export interface AgentChatVersions {
    switcher: (itemId: string) => AgentChatVersionSwitcher | undefined;
    step: (switcher: AgentChatVersionSwitcher, index: number) => void;
    /**
     * Whether an item on screen belongs to an earlier version, which offers no Edit, Fork, or Restore code.
     */
    isEarlier: (itemId: string) => boolean;
}

export const AgentChatVersionsContext = createContext<AgentChatVersions | undefined>(undefined);

export function useAgentChatVersions(): AgentChatVersions | undefined {
    return useContext(AgentChatVersionsContext);
}

const EMPTY_SUMMARIES: never[] = [];

/**
 * The Chat pane's earlier versions: the snapshot its timeline renders with the selected versions swapped in, the
 * context its user messages read, and whether an earlier version is on screen. Only a provider that rewinds
 * (`isEnabled`) keeps any.
 */
export function useAgentChatVersionView(
    terminalId: string,
    snapshot: AgentChatSnapshot | undefined,
    isEnabled: boolean,
) {
    const hasTurns = (snapshot?.turns.length ?? 0) > 0;
    const summaries = useQuery({
        ...agentChatVersionsQuery(terminalId, snapshot?.historyId),
        enabled: isEnabled && hasTurns && snapshot?.historyId !== undefined,
    }).data;
    const stored = useAgentChatVersionSelectionStore(selectAgentChatVersionSelection(terminalId));
    const selection = useMemo(() => new Map(Object.entries(stored)), [stored]);
    const selectedIds = useMemo(() => [...new Set(selection.values())], [selection]);
    const contents = useQueries({
        queries: selectedIds.map((versionId) => agentChatVersionQuery(terminalId, versionId)),
        combine: (results) => results.map((result) => result.data),
    });
    const contentMap = useMemo(() => {
        const map = new Map<string, AgentChatVersionContent>();
        for (const [index, versionId] of selectedIds.entries()) {
            const content = contents[index];
            if (content) map.set(versionId, content);
        }
        return map;
    }, [contents, selectedIds]);
    const groups = useMemo(() => agentChatVersionGroups(summaries ?? EMPTY_SUMMARIES), [summaries]);
    const view = useMemo(
        () =>
            snapshot && groups.size > 0
                ? agentChatVersionView(snapshot, !snapshot.truncated, groups, selection, contentMap)
                : undefined,
        [contentMap, groups, selection, snapshot],
    );
    const versions = useMemo<AgentChatVersions | undefined>(() => {
        if (!view || view.switchers.size === 0) return;
        return {
            switcher: (itemId) => view.switchers.get(itemId),
            step: (switcher, index) => stepAgentChatVersion(terminalId, switcher, index),
            isEarlier: (itemId) => view.earlierItemIds.has(itemId),
        };
    }, [terminalId, view]);
    const showCurrent = useCallback(() => showCurrentAgentChatVersion(terminalId), [terminalId]);
    return {
        snapshot: snapshot && view ? agentChatSnapshotWithVersions(snapshot, view) : snapshot,
        versions,
        isViewingEarlier: view?.isViewingEarlier ?? false,
        showCurrent,
    };
}
