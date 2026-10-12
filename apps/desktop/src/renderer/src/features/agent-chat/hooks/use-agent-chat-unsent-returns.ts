import { useEffect } from 'react';

import { useLatestReference } from '@/hooks/use-latest-reference';

import type { AgentChatAttachment } from '../agent-chat-drafts';
import { subscribeAgentChatUnsentReturns } from '../agent-chat-drafts';

/**
 * Takes a message whose send failed back into this mounted composer (`returnUnsentAgentChatMessage`), for as long as
 * the composer is on screen.
 */
export function useAgentChatUnsentReturns(
    terminalId: string,
    restore: (text: string, attachments: readonly AgentChatAttachment[]) => void,
): void {
    const latestRestore = useLatestReference(restore);
    useEffect(
        () =>
            subscribeAgentChatUnsentReturns(terminalId, (text, attachments) =>
                latestRestore.current(text, attachments),
            ),
        [latestRestore, terminalId],
    );
}
