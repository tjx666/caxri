import { useQuery } from '@tanstack/react-query';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey } from '../../../queries/client';
import { agentChatImageThumbnail } from '../agent-chat-images';

/**
 * Which image of which sent message to preview; `undefined` when the message already carries its thumbnail.
 */
export interface AgentChatImageSource {
    terminalId: string;
    itemId: string;
    index: number;
}

/**
 * The preview of an image a resumed conversation knows only by count: the original comes back from the provider's
 * record (`agentChat.readImage`) and is shrunk here exactly like a newly attached image. Only the thumbnail is cached,
 * never the multi-megabyte original, and a sent message's images never change, so it is read once. `thumbnail` is
 * `undefined` while loading, and for good when the record no longer has the image; `status` tells the two apart so the
 * placeholder can say which.
 */
export function useAgentChatImageThumbnail(source: AgentChatImageSource | undefined): {
    thumbnail: string | undefined;
    status: 'idle' | 'loading' | 'ready' | 'unavailable';
} {
    const parameters = source ?? { terminalId: '', itemId: '', index: 0 };
    const query = useQuery({
        queryKey: [...caxriQueryKey('agentChat.readImage', parameters), 'thumbnail'],
        queryFn: async () => {
            const image = await caxri.request('agentChat.readImage', parameters);
            return image ? agentChatImageThumbnail(image) : null;
        },
        enabled: source !== undefined,
        staleTime: Infinity,
        retry: false,
    });
    const thumbnail = query.data ?? undefined;
    if (thumbnail) return { thumbnail, status: 'ready' };
    if (source === undefined) return { thumbnail, status: 'idle' };
    return { thumbnail, status: query.isPending ? 'loading' : 'unavailable' };
}

/**
 * The full-size image behind a preview, read from the provider's record only while the larger preview is open. The
 * original can be several megabytes, so it is dropped from the cache as soon as the preview closes instead of being
 * kept like the thumbnail. `undefined` while loading or when the record no longer has it; the preview shows the
 * thumbnail meanwhile.
 */
export function useAgentChatImageOriginal(
    source: AgentChatImageSource | undefined,
    { isEnabled }: { isEnabled: boolean },
): string | undefined {
    const parameters = source ?? { terminalId: '', itemId: '', index: 0 };
    const query = useQuery({
        queryKey: [...caxriQueryKey('agentChat.readImage', parameters), 'original'],
        queryFn: async () => {
            const image = await caxri.request('agentChat.readImage', parameters);
            return image ? `data:${image.mediaType};base64,${image.data}` : null;
        },
        enabled: isEnabled && source !== undefined,
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    return query.data ?? undefined;
}
