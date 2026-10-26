import { createStore } from '../../../../lib/store';

const NONE: ReadonlySet<string> = new Set();

interface AgentChatSeenFailuresState {
    /**
     * Per Chat Terminal, the failed background tasks the user dismissed from the Background work section.
     */
    seen: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Remembered for this window's lifetime only: after a restart, `agentChatBackgroundWork` already ignores failures older
 * than the latest turn, so only the latest turn's failures can call for attention again.
 */
const useSeenFailuresStore = createStore<AgentChatSeenFailuresState>(
    'agentChatSeenTaskFailures',
    () => ({ seen: new Map() }),
);

/**
 * `seen` with `taskIds` added for `terminalId`, or `seen` itself when nothing is new, so subscribers skip a no-op.
 */
export function withSeenFailures(
    seen: ReadonlyMap<string, ReadonlySet<string>>,
    terminalId: string,
    taskIds: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
    const current = seen.get(terminalId) ?? NONE;
    if (taskIds.every((id) => current.has(id))) return seen;
    return new Map(seen).set(terminalId, new Set([...current, ...taskIds]));
}

/**
 * Marks failures as seen once the user dismissed them, which moves them under the section's ended tasks.
 */
export function markAgentChatFailuresSeen(terminalId: string, taskIds: readonly string[]): void {
    useSeenFailuresStore.setState(({ seen }) => ({
        seen: withSeenFailures(seen, terminalId, taskIds),
    }));
}

export function useAgentChatSeenFailures(terminalId: string): ReadonlySet<string> {
    return useSeenFailuresStore(({ seen }) => seen.get(terminalId) ?? NONE);
}
