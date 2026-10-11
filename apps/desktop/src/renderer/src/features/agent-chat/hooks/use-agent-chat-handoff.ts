import { useState } from 'react';

import type { TerminalRecord } from '@caxri/protocol';

import { didContinueAgentChatInNewChat } from '../agent-chat-commands';

/**
 * The composer's "Continue in new Chat" action. The draft travels to the new Chat as its pending request, so it is
 * cleared only once that Chat accepted the handoff prompt; `isContinuing` blocks a second click from opening another.
 */
export function useAgentChatHandoff({
    clearDraft,
    draft,
    providerName,
    terminal,
}: {
    clearDraft: () => void;
    draft: string;
    providerName: string;
    terminal: TerminalRecord | undefined;
}): { continueInNewChat: () => void; isContinuing: boolean } {
    const [isContinuing, setIsContinuing] = useState(false);
    const continueInNewChat = (): void => {
        if (!terminal || isContinuing) return;
        setIsContinuing(true);
        // eslint-disable-next-line no-void -- every failure is reported through a toast inside the command
        void didContinueAgentChatInNewChat(terminal, { pendingRequest: draft, providerName })
            .then((isContinued) => {
                if (isContinued) clearDraft();
            })
            .finally(() => setIsContinuing(false));
    };
    return { continueInNewChat, isContinuing };
}
