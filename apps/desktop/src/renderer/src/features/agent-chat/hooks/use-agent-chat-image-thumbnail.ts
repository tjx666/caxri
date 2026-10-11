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
 * never the multi-megabyte original, and a sent message's images never change, so it is read once. `undefined` while
 * loading, and for good when the record no longer has the image; the caller keeps its placeholder either way.
 */
export function useAgentChatImageThumbnail(source: AgentChatImageSource | undefined) {
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
    return query.data ?? undefined;
}
