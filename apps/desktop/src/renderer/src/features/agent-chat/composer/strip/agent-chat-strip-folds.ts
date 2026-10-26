import { createStore } from '../../../../lib/store';

/**
 * A collapsible section in the composer strip.
 */
export type AgentChatStripSection = 'plan' | 'tasks';

interface AgentChatStripFoldsState {
    /**
     * Per Chat Terminal, the sections the user collapsed. Every section starts expanded.
     */
    collapsed: ReadonlyMap<string, ReadonlySet<AgentChatStripSection>>;
}

const NONE: ReadonlySet<AgentChatStripSection> = new Set();

/**
 * Remembered for this window's lifetime, so a section the user folded stays folded when it leaves with its work and
 * comes back on the next turn, and when the user switches Sessions and back.
 */
const useStripFoldsStore = createStore<AgentChatStripFoldsState>('agentChatStripFolds', () => ({
    collapsed: new Map(),
}));

/**
 * `collapsed` with `section` flipped for `terminalId`.
 */
export function withToggledFold(
    collapsed: ReadonlyMap<string, ReadonlySet<AgentChatStripSection>>,
    terminalId: string,
    section: AgentChatStripSection,
): ReadonlyMap<string, ReadonlySet<AgentChatStripSection>> {
    const next = new Set(collapsed.get(terminalId) ?? NONE);
    if (!next.delete(section)) next.add(section);
    return new Map(collapsed).set(terminalId, next);
}

export function toggleAgentChatStripFold(terminalId: string, section: AgentChatStripSection): void {
    useStripFoldsStore.setState(({ collapsed }) => ({
        collapsed: withToggledFold(collapsed, terminalId, section),
    }));
}

export function useIsAgentChatStripSectionCollapsed(
    terminalId: string,
    section: AgentChatStripSection,
): boolean {
    return useStripFoldsStore(({ collapsed }) => collapsed.get(terminalId)?.has(section) ?? false);
}
