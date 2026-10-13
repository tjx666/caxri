import { createStore } from '../../lib/store';

interface AgentChatGoalModeState {
    /**
     * Chat Terminals whose composer is in Goal mode. A store rather than component state, so the mode survives the
     * composer unmounting when the user switches tabs or Sessions, as the draft it applies to does.
     */
    terminalIds: ReadonlySet<string>;
}

/**
 * Goal mode: the composer's next Enter sets the draft as the provider's goal (`/goal <draft>`) instead of sending it as
 * a message, as the Codex app's Goal chip does. The draft stays plain text, so caret-based features (paths, `@`
 * references, prompt history) keep working on what the user sees.
 */
export const useAgentChatGoalModeStore = createStore<AgentChatGoalModeState>(
    'agentChatGoalMode',
    () => ({ terminalIds: new Set() }),
);

export function setAgentChatGoalMode(terminalId: string, isOn: boolean): void {
    useAgentChatGoalModeStore.setState(({ terminalIds }) => {
        if (terminalIds.has(terminalId) === isOn) return { terminalIds };
        const next = new Set(terminalIds);
        if (isOn) next.add(terminalId);
        else next.delete(terminalId);
        return { terminalIds: next };
    });
}
