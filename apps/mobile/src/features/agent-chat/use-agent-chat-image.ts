import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

import { useMobileClient } from '../connection/mobile-client-provider';
import type { AgentChatImageTarget } from './agent-chat-images';
import {
    agentChatImageDataUri,
    agentChatImageExtension,
    readAgentChatImage,
} from './agent-chat-images';

/**
 * An original is several megabytes of base64, too large to hand an `Image` as a data URI, so it is written to the app's
 * cache under a name derived from its target. Reopening the same image overwrites the same file.
 */
const writeOriginal = async (
    target: AgentChatImageTarget,
    image: { mediaType: Parameters<typeof agentChatImageExtension>[0]; data: string },
): Promise<string> => {
    const name = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        JSON.stringify([target.terminalId, target.itemId, target.index]),
    );
    const file = new File(
        Paths.cache,
        `agent-chat-image-${name.slice(0, 32)}.${agentChatImageExtension(image.mediaType)}`,
    );
    file.write(image.data, { encoding: 'base64' });
    return file.uri;
};

/**
 * One image of a Chat message, read on demand: a thumbnail as a data URI, or an original as a cached file. Images in a
 * sent message never change, so a loaded one is never refetched, like Desktop's thumbnail fallback.
 */
export const useAgentChatImage = (target: AgentChatImageTarget) => {
    const { connectionScopeKey, request, status } = useMobileClient();
    const [progress, setProgress] = useState(0);
    const query = useQuery({
        enabled: connectionScopeKey !== null && status === 'connected',
        gcTime: (target.variant === 'original' ? 2 : 10) * 60_000,
        networkMode: 'always',
        queryKey: [
            'mobile',
            'agentChatImage',
            connectionScopeKey,
            target.terminalId,
            target.itemId,
            target.index,
            target.variant,
        ],
        queryFn: async (): Promise<string | null> => {
            setProgress(0);
            const image = await readAgentChatImage(
                (chunkIndex) => request('mobile.agentChat.readImage', { ...target, chunkIndex }),
                setProgress,
            );
            if (!image) return null;
            return target.variant === 'original'
                ? writeOriginal(target, image)
                : agentChatImageDataUri(image);
        },
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: Infinity,
    });
    return {
        uri: query.data ?? null,
        isLoading: query.isPending && query.fetchStatus !== 'idle',
        isMissing: query.isSuccess && query.data === null,
        isError: query.isError,
        progress,
        retry: () => {
            // eslint-disable-next-line no-void -- The query owns the resulting state.
            void query.refetch();
        },
    };
};
