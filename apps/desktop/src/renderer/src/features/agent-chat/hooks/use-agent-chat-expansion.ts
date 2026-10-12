import { createContext, useContext, useState, useSyncExternalStore } from 'react';

import type { AgentChatWorkItem } from '@caxri/protocol';

import { AgentChatExpansionState, isAgentChatExpanded } from '../agent-chat-expansion';

/**
 * A Chat timeline's disclosure state and what a user toggle does to scrolling, provided by the Chat pane (and by a task
 * tab's read-only timeline) so expanded rows survive the timeline rebuilding them.
 */
export interface AgentChatExpansion {
    state: AgentChatExpansionState;
    /**
     * Runs before a row the user clicked changes height, with the clicked control, so the scroll view can hold it in
     * place instead of following the end.
     */
    onUserToggle?: (element: HTMLElement) => void;
}

export const AgentChatExpansionContext = createContext<AgentChatExpansion | undefined>(undefined);

/**
 * One disclosure's expanded state. It opens by default when `isDefaultExpanded` holds or when the user expanded any of
 * `containedItems` themselves (a live row they opened that has since merged into this group or turn), and an explicit
 * toggle wins over both. Without a provider it keeps its own state, as a row did before.
 */
export function useAgentChatExpansion(
    key: string,
    {
        containedItems,
        isDefaultExpanded = false,
    }: {
        containedItems?: readonly AgentChatWorkItem[];
        isDefaultExpanded?: boolean;
    } = {},
): {
    isExpanded: boolean;
    /**
     * Flips the stored state, or sets it to `isNextExpanded` when the row shows a different state than the store holds
     * (a turn fold a find opened).
     */
    toggle: (element: HTMLElement, isNextExpanded?: boolean) => void;
} {
    const provided = useContext(AgentChatExpansionContext);
    const [local] = useState<AgentChatExpansion>(() => ({ state: new AgentChatExpansionState() }));
    const { state, onUserToggle } = provided ?? local;
    /**
     * The snapshot is the answer itself, not the store's version: React Compiler memoizes a value computed from `state`
     * and `key`, which never change, so reading the store outside the snapshot kept the first answer after a toggle.
     */
    const isExpanded = useSyncExternalStore(state.subscribe, () =>
        isAgentChatExpanded(
            state.get(key),
            isDefaultExpanded ||
                (containedItems !== undefined && state.hasExpandedItem(containedItems)),
        ),
    );
    return {
        isExpanded,
        toggle: (element, isNextExpanded = !isExpanded) => {
            onUserToggle?.(element);
            state.set(key, isNextExpanded);
        },
    };
}
