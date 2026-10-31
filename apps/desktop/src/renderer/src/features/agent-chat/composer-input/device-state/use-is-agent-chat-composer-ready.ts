import { useSyncExternalStore } from 'react';

import { agentChatComposerState } from './agent-chat-composer-state';

/**
 * Whether this window's stored images have been read (drafts and edits are read synchronously). A composer takes its
 * images once, when it mounts, so a Chat pane waits for this before it renders: otherwise a Chat opened right after a
 * reload would show its draft's image placeholders as plain text without the images.
 */
export function useIsAgentChatComposerReady(): boolean {
    return useSyncExternalStore(
        agentChatComposerState.subscribeReady,
        agentChatComposerState.isReady,
    );
}
