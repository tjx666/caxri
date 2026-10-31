import type { AgentChatSnapshot, MethodResult } from '@caxri/protocol';
import { agentChatMessageVideoPaths } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

type VideoRead = MethodResult<'mobile.video.read'>;

/**
 * Which cited video of which Chat message; Server Core serves a path only to the message that cites it.
 */
export interface AgentChatVideoTarget {
    terminalId: string;
    itemId: string;
    path: string;
}

/**
 * The user messages that cite videos and the paths each cites, in order of first mention, as a stable string so a view
 * can memoize on it while replies stream. Empty when no message cites a video.
 */
export const agentChatVideoPaths = (
    snapshot: Pick<AgentChatSnapshot, 'items'> | undefined,
): string => {
    const entries = (snapshot?.items ?? []).flatMap((item) => {
        if (item.type !== 'userMessage') return [];
        const paths = agentChatMessageVideoPaths(item.text);
        return paths.length > 0 ? [[item.id, paths] as const] : [];
    });
    return entries.length > 0 ? JSON.stringify(entries) : '';
};

/**
 * A card's poster read: `unavailable` when the computer reports the file gone, otherwise the poster as a data URI, or
 * `null` when the computer could not draw a frame and the card keeps its placeholder.
 */
export type AgentChatVideoPoster = { kind: 'unavailable' } | { kind: 'ready'; uri: string | null };

/**
 * Pages the poster through `mobile.video.read` and joins the chunks, like `readAgentChatImage`. Fails when the poster
 * changed between chunks rather than joining two different frames.
 */
export async function readAgentChatVideoPoster(
    readChunk: (chunkIndex: number) => Promise<VideoRead>,
): Promise<AgentChatVideoPoster> {
    const first = await readChunk(0);
    if (!first) return { kind: 'unavailable' };
    if (!first.poster) return { kind: 'ready', uri: null };
    const { chunkCount, mediaType } = first.poster;
    const parts = [first.poster.data];
    for (let chunkIndex = 1; chunkIndex < chunkCount; chunkIndex += 1) {
        // The Server pages one poster in order, and one chunk already fills a gateway frame.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const next = await readChunk(chunkIndex); // eslint-disable-line no-await-in-loop
        if (
            !next?.poster ||
            next.poster.chunkCount !== chunkCount ||
            next.poster.mediaType !== mediaType
        )
            throw new Error('The poster changed while it was loading.');
        parts.push(next.poster.data);
    }
    return { kind: 'ready', uri: `data:${mediaType};base64,${parts.join('')}` };
}

/**
 * Why the player cannot start, or `null` when it can: the stream is plain HTTP on the gateway's LAN address, so it
 * needs a live direct connection, and the Relay cannot carry it.
 */
export const agentChatVideoBlocker = (
    connection: { route: 'direct' | 'relay' | null; status: string },
    t: Translate = translate,
): string | null => {
    if (connection.status !== 'connected') return t('chat.video.offline');
    if (connection.route === 'relay') return t('chat.video.relay');
    return null;
};
