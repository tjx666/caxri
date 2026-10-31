import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-errors';
import type { AgentChatVideoPoster, AgentChatVideoTarget } from './agent-chat-videos';
import { readAgentChatVideoPoster } from './agent-chat-videos';

const posterKey = (connectionScopeKey: string | null, target: AgentChatVideoTarget) =>
    [
        'mobile',
        'agentChatVideo',
        connectionScopeKey,
        target.terminalId,
        target.itemId,
        target.path,
    ] as const;

/**
 * A cited video's poster and whether the file still exists. Unlike a message image the file lives on the computer and
 * can be deleted, so every mount asks again while the last answer stays on screen; Server Core caches the poster, so a
 * repeat read is one small frame.
 */
export const useAgentChatVideoPoster = (target: AgentChatVideoTarget) => {
    const { connectionScopeKey, request, status } = useMobileClient();
    const query = useQuery({
        enabled: connectionScopeKey !== null && status === 'connected',
        gcTime: 10 * 60_000,
        networkMode: 'always',
        queryKey: posterKey(connectionScopeKey, target),
        queryFn: (): Promise<AgentChatVideoPoster> =>
            readAgentChatVideoPoster((chunkIndex) =>
                request('mobile.video.read', { ...target, chunkIndex }),
            ),
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return {
        isUnavailable: query.data?.kind === 'unavailable',
        uri: query.data?.kind === 'ready' ? query.data.uri : null,
    };
};

/**
 * The stream URL for the player, asked for when the player opens. A `NOT_FOUND` means the file was deleted since the
 * card loaded, so the card's poster read is redone and the card turns unavailable.
 */
export const useAgentChatVideoStream = (target: AgentChatVideoTarget, isEnabled: boolean) => {
    const { connectionScopeKey, request } = useMobileClient();
    const queryClient = useQueryClient();
    const query = useQuery({
        enabled: isEnabled && connectionScopeKey !== null,
        gcTime: 0,
        networkMode: 'always',
        queryKey: [...posterKey(connectionScopeKey, target), 'stream'],
        queryFn: async () => {
            try {
                return (await request('mobile.video.open', target)).url;
            } catch (error) {
                if (error instanceof MobileGatewayRequestError && error.code === 'NOT_FOUND')
                    void queryClient.invalidateQueries({
                        exact: true,
                        queryKey: posterKey(connectionScopeKey, target),
                    });
                throw error;
            }
        },
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return {
        url: query.data ?? null,
        isError: query.isError,
        isMissing:
            query.error instanceof MobileGatewayRequestError && query.error.code === 'NOT_FOUND',
    };
};
