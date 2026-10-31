import { realpath, stat } from 'node:fs/promises';

import type { AgentChatItem, Principal } from '@caxri/protocol';
import { agentChatMessageVideoPaths, CaxriError, isAgentChatVideoPath } from '@caxri/protocol';

import type { ServerDomainService } from '../../domain-service';
import { agentChatHistoryPageBefore, agentChatTerminalForPrincipal } from '../agent-chat-requests';

/**
 * A video one user message of a Chat cites, as the phone names it.
 */
export interface MobileVideoTarget {
    terminalId: string;
    itemId: string;
    path: string;
}

/**
 * History pages read looking for a message older than the Chat's projection. A phone shows a card only for a message it
 * has loaded, and it loads history one page at a time from the newest, so a message this deep is rare; past it the card
 * reads as unavailable instead of the Server reading the whole record.
 */
const MAXIMUM_HISTORY_PAGES = 20;

/**
 * The videos of messages already found, keyed by Chat and message. A sent message never changes, and a card asks once
 * for every poster chunk and again to play, so each message is looked up once.
 */
const citedVideos = new Map<string, readonly string[]>();
const CITED_VIDEO_CACHE_LIMIT = 128;

const isUserMessage = (
    item: AgentChatItem,
): item is Extract<AgentChatItem, { type: 'userMessage' }> => item.type === 'userMessage';

async function messageVideos(
    domainService: ServerDomainService,
    terminalId: string,
    itemId: string,
): Promise<readonly string[] | undefined> {
    const key = JSON.stringify([terminalId, itemId]);
    const cached = citedVideos.get(key);
    if (cached) return cached;
    const snapshot = await domainService.request('agentChat.read', { terminalId });
    let items: readonly AgentChatItem[] = snapshot.items;
    let found = items.find((item) => item.id === itemId);
    // Only a truncated projection has older history to page through.
    let hasMore = snapshot.truncated === true;
    for (
        let page = 0;
        !found && hasMore && page < MAXIMUM_HISTORY_PAGES && items.length > 0;
        page += 1
    ) {
        // Each page starts where the previous one ended, so the pages are read in order.
        // eslint-disable-next-line no-await-in-loop
        const older = await agentChatHistoryPageBefore(domainService, terminalId, items[0].id);
        items = older.items;
        found = items.find((item) => item.id === itemId);
        ({ hasMore } = older);
    }
    if (!found || !isUserMessage(found)) return undefined;
    const videos = agentChatMessageVideoPaths(found.text);
    citedVideos.set(key, videos);
    while (citedVideos.size > CITED_VIDEO_CACHE_LIMIT)
        citedVideos.delete(citedVideos.keys().next().value!);
    return videos;
}

/**
 * Admits a phone's video request: the Chat Terminal resolves through the device's granted Projects, and `path` must be
 * a video the named user message cites (`agentChatMessageVideoPaths`). Like Desktop's media scheme, the path is not
 * held to the Project root, since a screen recording usually sits on the Desktop; the message is the authority. Any
 * other path is `NOT_FOUND`, so a phone cannot read an arbitrary file by naming it.
 */
export async function admitMobileVideo(
    domainService: ServerDomainService,
    principal: Principal,
    target: MobileVideoTarget,
): Promise<void> {
    await agentChatTerminalForPrincipal(domainService, principal, target.terminalId);
    const videos = await messageVideos(domainService, target.terminalId, target.itemId);
    if (!videos?.includes(target.path))
        throw new CaxriError('NOT_FOUND', 'This message cites no such video');
}

/**
 * The file a cited video names, resolved through symlinks, or `undefined` when it is gone, is not a regular file, or
 * resolves to a name that is not a video, so a link named like a video cannot serve another file.
 */
export async function resolveMobileVideoFile(
    path: string,
): Promise<{ modifiedAt: number; path: string; size: number } | undefined> {
    try {
        const resolved = await realpath(path);
        const stats = await stat(resolved);
        if (!stats.isFile() || !isAgentChatVideoPath(resolved)) return undefined;
        return { modifiedAt: stats.mtimeMs, path: resolved, size: stats.size };
    } catch {
        return undefined;
    }
}

/**
 * Forgets every looked-up message, for tests.
 */
export function clearMobileCitedVideos(): void {
    citedVideos.clear();
}
