import type { AgentChatSnapshot } from '@caxri/protocol';
import { currentAgentChatAwayRecap } from '@caxri/protocol';

import { createStore } from '../../../../lib/store';

interface AgentChatAwayRecapState {
    /**
     * Per Chat Terminal, the `generatedAt` of the recap the user closed. Keyed by generation rather than a flag so the
     * next recap of the same Chat shows again.
     */
    dismissed: Readonly<Record<string, number>>;
    dismiss: (terminalId: string, generatedAt: number) => void;
}

/**
 * Which away recaps the user closed in this window. Memory only, like the recap itself: the Server keeps it on the live
 * projection, so a restart forgets both together.
 */
export const useAgentChatAwayRecapStore = createStore<AgentChatAwayRecapState>(
    'agentChatAwayRecap',
    (set) => ({
        dismissed: {},
        dismiss: (terminalId, generatedAt) =>
            set((state) => ({ dismissed: { ...state.dismissed, [terminalId]: generatedAt } })),
    }),
);

/**
 * The recap to show at the end of this Chat's transcript: the current one (`currentAgentChatAwayRecap`, which already
 * drops a recap once the Chat replies again or starts a turn), unless the user closed that very recap.
 */
export function visibleAgentChatAwayRecap(
    snapshot: AgentChatSnapshot | undefined,
    dismissedAt: number | undefined,
): NonNullable<AgentChatSnapshot['awayRecap']> | undefined {
    const recap = currentAgentChatAwayRecap(snapshot);
    if (!recap || recap.generatedAt === dismissedAt) return undefined;
    return recap;
}

/**
 * The recap this Chat shows at the end of its transcript right now, reading the closed recaps from the window's store.
 */
export function useVisibleAgentChatAwayRecap(
    snapshot: AgentChatSnapshot | undefined,
    terminalId: string,
): NonNullable<AgentChatSnapshot['awayRecap']> | undefined {
    const dismissedAt = useAgentChatAwayRecapStore((state) => state.dismissed[terminalId]);
    return visibleAgentChatAwayRecap(snapshot, dismissedAt);
}

/**
 * Whether "Jump to latest" carries the recap cue: a recap waits at the end of the transcript and the end is out of
 * view, so the user returning to an earlier position would otherwise never learn it is there.
 */
export function shouldCueAwayRecap(
    recap: NonNullable<AgentChatSnapshot['awayRecap']> | undefined,
    isLatestInView: boolean,
): boolean {
    return recap !== undefined && !isLatestInView;
}
