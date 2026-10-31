import { createStore } from '../../../lib/store';
import type { AgentChatVersionSelection, AgentChatVersionSwitcher } from './agent-chat-versions';
import { selectAgentChatVersion } from './agent-chat-versions';

/**
 * Which earlier version each Chat shows at each switch point, kept in memory so it survives a tab or Session switch,
 * while a restart opens every Chat on its current version. Keyed by Chat Terminal, then by `agentChatVersionKey`.
 */
interface AgentChatVersionSelectionState {
    selections: Record<string, Record<string, string>>;
}

export const useAgentChatVersionSelectionStore = createStore<AgentChatVersionSelectionState>(
    'agent-chat-version-selection',
    () => ({ selections: {} }),
);

const NO_SELECTION: Record<string, string> = {};

export function selectAgentChatVersionSelection(terminalId: string) {
    return (state: AgentChatVersionSelectionState) => state.selections[terminalId] ?? NO_SELECTION;
}

function write(terminalId: string, selection: AgentChatVersionSelection): void {
    useAgentChatVersionSelectionStore.setState((state) => {
        const selections = { ...state.selections };
        if (selection.size === 0) delete selections[terminalId];
        else selections[terminalId] = Object.fromEntries(selection);
        return { selections };
    });
}

/**
 * Steps one switcher to the version at `index`.
 */
export function stepAgentChatVersion(
    terminalId: string,
    switcher: AgentChatVersionSwitcher,
    index: number,
): void {
    const { selections } = useAgentChatVersionSelectionStore.getState();
    const selection = new Map(
        Object.hasOwn(selections, terminalId) ? Object.entries(selections[terminalId]) : [],
    );
    write(terminalId, selectAgentChatVersion(selection, switcher, index));
}

/**
 * Shows the current version everywhere again, as sending a message does: the conversation continues there.
 */
export function showCurrentAgentChatVersion(terminalId: string): void {
    if (Object.hasOwn(useAgentChatVersionSelectionStore.getState().selections, terminalId))
        write(terminalId, new Map());
}
