import { useSyncExternalStore } from 'react';

import { agentChatComposerState } from './agent-chat-composer-state';

/**
 * Whether the stored images of a Chat's composer scope have been read (drafts and edits are read synchronously). A
 * composer takes its images once, when it mounts, so a Chat pane waits for this before it renders: otherwise a Chat
 * opened right after a reload would show its draft's image placeholders as plain text without the images.
 */
export function useIsAgentChatComposerReady(terminalId: string): boolean {
    return useSyncExternalStore(agentChatComposerState.subscribeReady, () =>
        agentChatComposerState.isReady(terminalId),
    );
}
