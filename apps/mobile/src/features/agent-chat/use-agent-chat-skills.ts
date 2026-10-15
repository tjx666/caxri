import { agentChatSlashQuery } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-errors';

/**
 * The skills discovered for a Chat's Agent Terminal that match the bare `/name` or `$name` being typed, as Desktop's
 * Chat menu lists them. The Server ranks the Terminal's whole action list by the typed name (`mobile.agent.actions`
 * with `query`) and returns its bounded top slice, so a skill outside the first page is still found. It asks only while
 * the draft is a bare invocation and the phone is connected and in the foreground; the previous answer stays on screen
 * while the next keystroke's request runs so the menu does not flicker.
 */
export const useAgentChatSkills = ({
    draft,
    isEnabled,
    sessionId,
    terminalId,
}: {
    draft: string;
    /**
     * False while the composer cannot send, when the menu is hidden anyway.
     */
    isEnabled: boolean;
    sessionId: string;
    terminalId: string | undefined;
}) => {
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const query = agentChatSlashQuery(draft);
    const enabled =
        isEnabled &&
        query !== undefined &&
        terminalId !== undefined &&
        status === 'connected' &&
        isForeground &&
        connectionScopeKey !== null;
    const actions = useQuery({
        enabled,
        // Only the same Terminal's earlier answer may stand in; another Session's skills never flash up here.
        placeholderData: (previous, previousQuery) =>
            previousQuery?.queryKey[4] === terminalId ? previous : undefined,
        queryFn: () =>
            request('mobile.agent.actions', { sessionId, terminalId: terminalId!, query: query! }),
        queryKey: ['mobile', 'agent-chat-skills', connectionScopeKey, sessionId, terminalId, query],
        retry: false,
        staleTime: 30_000,
    });
    const isUnavailable =
        actions.error instanceof MobileGatewayRequestError && actions.error.code === 'UNAVAILABLE';
    return {
        skills: enabled ? actions.data?.actions : undefined,
        isPending: enabled && actions.isPending,
        isUnavailable: enabled && isUnavailable,
    };
};
