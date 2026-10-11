import type {
    AgentChatImageMediaType,
    AgentChatSnapshot,
    Principal,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import {
    CaxriError,
    MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH,
    windowAgentChatSnapshotForMobile,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { terminalForPrincipal } from './action-requests';

export type MobileAgentChatRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.agentChat.read'
            | 'mobile.agentChat.readImage'
            | 'mobile.agentChat.send'
            | 'mobile.agentChat.interrupt'
            | 'mobile.agentChat.respond'
            | 'mobile.agentChat.retry'
            | 'mobile.agentChat.configure';
    }
>;

/**
 * A read needs no mutation authority; the access controller invokes it without serializing behind a revoke.
 */
export const isMobileAgentChatRead = (request: MobileAgentChatRequest): boolean =>
    request.method === 'mobile.agentChat.read' || request.method === 'mobile.agentChat.readImage';

/**
 * Forwards a Server operation through Core's mutation admission, the same path a Desktop request takes.
 */
export type MobileOperationForwarder = (request: ServerOperationRequest) => Promise<unknown>;

/**
 * Resolves a Terminal through the device's granted Projects and accepts only a Chat, so a phone can never reach a PTY
 * through the Chat methods or subscription.
 */
export async function agentChatTerminalForPrincipal(
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
) {
    const terminal = await terminalForPrincipal(domainService, principal, terminalId);
    if (terminal.surface !== 'chat')
        throw new CaxriError('CONFLICT', 'This Terminal is not an Agent Chat');
    return terminal;
}

interface ImageData {
    mediaType: AgentChatImageMediaType;
    data: string;
}

/**
 * The originals a phone is currently paging through. A provider record is re-read for every `agentChat.readImage`, and
 * an original arrives in dozens of chunks, so the last few stay in memory briefly instead of being re-read per chunk.
 */
const recentOriginals = new Map<string, { image: ImageData | null; expiresAt: number }>();
const RECENT_ORIGINALS_LIMIT = 2;
const RECENT_ORIGINAL_LIFETIME_MS = 60_000;

async function readOriginal(
    domainService: ServerDomainService,
    target: { terminalId: string; itemId: string; index: number },
): Promise<ImageData | null> {
    const key = JSON.stringify([target.terminalId, target.itemId, target.index]);
    const now = Date.now();
    for (const [cached, entry] of recentOriginals)
        if (entry.expiresAt <= now) recentOriginals.delete(cached);
    const hit = recentOriginals.get(key);
    if (hit) return hit.image;
    const image = await domainService.request('agentChat.readImage', target);
    recentOriginals.set(key, { image, expiresAt: now + RECENT_ORIGINAL_LIFETIME_MS });
    while (recentOriginals.size > RECENT_ORIGINALS_LIMIT)
        recentOriginals.delete(recentOriginals.keys().next().value!);
    return image;
}

const THUMBNAIL_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/su;

function thumbnailOf(snapshot: AgentChatSnapshot, itemId: string, index: number): ImageData | null {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    const thumbnail = item?.type === 'userMessage' ? item.images?.[index]?.thumbnail : undefined;
    const match = thumbnail ? THUMBNAIL_PATTERN.exec(thumbnail) : null;
    return match ? { mediaType: match[1] as AgentChatImageMediaType, data: match[2] } : null;
}

/**
 * Drives one Agent Chat for a paired device. The Terminal is resolved through the device's granted Projects first, and
 * only a Chat Terminal is accepted, so a phone can never reach a PTY through these methods.
 */
export async function invokeMobileAgentChatRequest(
    request: MobileAgentChatRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    forwardOperation: MobileOperationForwarder | undefined,
    reauthorize: () => unknown,
): Promise<AgentChatSnapshot | (ImageData & { chunkIndex: number; chunkCount: number }) | null> {
    if (!forwardOperation)
        throw new CaxriError('UNAVAILABLE', 'Agent Chat is unavailable to paired devices');
    const forward = forwardOperation;
    const { terminalId } = request.params;
    const terminal = await agentChatTerminalForPrincipal(domainService, principal, terminalId);
    reauthorize();
    switch (request.method) {
        case 'mobile.agentChat.read': {
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            reauthorize();
            return windowAgentChatSnapshotForMobile(snapshot);
        }
        case 'mobile.agentChat.readImage': {
            const { itemId, index, variant, chunkIndex } = request.params;
            const image =
                variant === 'thumbnail'
                    ? thumbnailOf(
                          await domainService.request('agentChat.read', { terminalId }),
                          itemId,
                          index,
                      )
                    : await readOriginal(domainService, { terminalId, itemId, index });
            reauthorize();
            if (!image) return null;
            const chunkCount = Math.max(
                1,
                Math.ceil(image.data.length / MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH),
            );
            if (chunkIndex >= chunkCount)
                throw new CaxriError('VALIDATION', 'Image chunk is out of range');
            const start = chunkIndex * MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH;
            return {
                mediaType: image.mediaType,
                data: image.data.slice(start, start + MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH),
                chunkIndex,
                chunkCount,
            };
        }
        case 'mobile.agentChat.send': {
            const attachments = request.params.attachments ?? [];
            const uploaded =
                attachments.length > 0
                    ? await domainService.request('mobile.image.readInternal', {
                          sessionId: terminal.sessionId,
                          attachmentIds: attachments.flatMap((attachment) => [
                              attachment.attachmentId,
                              attachment.thumbnailAttachmentId,
                          ]),
                          principal,
                      })
                    : [];
            reauthorize();
            const images = attachments.map((_, index) => ({
                mediaType: 'image/jpeg' as const,
                data: uploaded[index * 2],
                thumbnail: `data:image/jpeg;base64,${uploaded[index * 2 + 1]}`,
            }));
            /**
             * Paired devices do not see Desktop's message queue, so a message sent during a turn steers it, as it did
             * before the queue existed, instead of waiting somewhere the sender cannot see.
             */
            await forward({
                method: 'agentChat.send',
                params: {
                    terminalId,
                    text: request.params.text,
                    ...(images.length > 0 && { images }),
                    delivery: 'steer',
                },
            });
            return null;
        }
        case 'mobile.agentChat.interrupt': {
            await forward({ method: 'agentChat.interrupt', params: { terminalId } });
            return null;
        }
        case 'mobile.agentChat.respond': {
            await forward({
                method: 'agentChat.respond',
                params: {
                    terminalId,
                    requestId: request.params.requestId,
                    response: request.params.response,
                },
            });
            return null;
        }
        case 'mobile.agentChat.configure': {
            /**
             * Core validates the switch against the Chat's listed models (`resolveAgentChatModelChange`), so a phone
             * holding a stale list cannot choose a model or effort the provider never offered.
             */
            await forward({
                method: 'agentChat.configure',
                params: {
                    terminalId,
                    ...(request.params.model !== undefined && { model: request.params.model }),
                    ...(request.params.effort !== undefined && { effort: request.params.effort }),
                },
            });
            return null;
        }
        case 'mobile.agentChat.retry': {
            /**
             * Mirrors the Desktop pane: only a failed provider is restarted (which clears the failure and resumes the
             * bound conversation); otherwise a read is enough, and restarting would cut off a running turn.
             */
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            if (snapshot.status === 'failed')
                await forward({
                    method: 'terminal.restart',
                    params: { terminalId, mode: 'resume' },
                });
            return null;
        }
    }
}
