import type { AgentProvider, ProcessState } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { useCaxriQuery } from '../../../queries/client';
import { agentChatReadFollowOptions } from '../agent-chat-cache-retention';
import {
    selectAgentChatPendingMessages,
    useAgentChatPendingStore,
} from '../transcript/agent-chat-pending';
import type { AgentChatComposerView } from './agent-chat-composer-snapshot';
import { selectAgentChatComposerView } from './agent-chat-composer-snapshot';

/**
 * What the composer shows of the Chat, selected from the shared `agentChat.read` entry instead of derived from the
 * pane's whole snapshot. The pane re-renders for every streamed patch because its transcript changes; the composer
 * shows none of the streamed text, and the selected value keeps its identity until a field it reads changes, so the
 * composer renders only when the turn starts or ends, the queue or usage moves, and so on.
 */
export function useAgentChatComposerSnapshot(
    terminalId: string,
    context: {
        hasConversation: boolean;
        isSessionVisible: boolean;
        processState: ProcessState | undefined;
        provider: AgentProvider | undefined;
        providerName: string;
    },
): AgentChatComposerView {
    const { t } = useTranslation();
    const pendingMessages = useAgentChatPendingStore(selectAgentChatPendingMessages(terminalId));
    const { hasConversation, isSessionVisible, processState, provider, providerName } = context;
    const { data } = useCaxriQuery(
        'agentChat.read',
        { terminalId },
        {
            staleTime: Infinity,
            ...agentChatReadFollowOptions(isSessionVisible),
            select: (snapshot) =>
                selectAgentChatComposerView(snapshot, {
                    hasConversation,
                    pendingMessages,
                    processState,
                    provider,
                    providerName,
                    t,
                }),
        },
    );
    // `select` does not run while the query has no data, and the composer must still say "loading".
    return (
        data ??
        selectAgentChatComposerView(undefined, {
            hasConversation,
            pendingMessages,
            processState,
            provider,
            providerName,
            t,
        })
    );
}
