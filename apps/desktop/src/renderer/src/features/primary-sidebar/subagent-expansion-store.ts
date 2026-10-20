import { createStore } from '../../lib/store';

interface SubagentExpansionState {
    /**
     * Sessions whose subagent list shows every subagent instead of the newest few. Renderer-lifetime only: a collapsed
     * list is the default and costs the user nothing to open again.
     */
    expandedSessionIds: ReadonlySet<string>;
    toggle: (sessionId: string) => void;
}

/**
 * Per-Session "show more subagents" state. A store rather than props so toggling one Session re-renders only that
 * Session's rows, and the tree's row order can read the same answer the rows render.
 */
export const useSubagentExpansionStore = createStore<SubagentExpansionState>(
    'primarySidebarSubagentExpansion',
    (set) => ({
        expandedSessionIds: new Set<string>(),
        toggle: (sessionId) =>
            set((state) => {
                const next = new Set(state.expandedSessionIds);
                if (!next.delete(sessionId)) next.add(sessionId);
                return { expandedSessionIds: next };
            }),
    }),
);
