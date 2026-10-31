import { useSyncExternalStore } from 'react';

import { agentChatComposerState } from './agent-chat-composer-state';

/**
 * Whether this window's stored composer state (drafts, "Edit from here", images) has been read. A composer reads it
 * once, when it mounts, so a Chat pane waits for this before it renders: otherwise a Chat opened right after a reload
 * would start empty and then overwrite the draft the user left.
 */
export function useIsAgentChatComposerReady(): boolean {
    return useSyncExternalStore(
        agentChatComposerState.subscribeReady,
        agentChatComposerState.isReady,
    );
}
