import type {
    AgentChatImageMediaType,
    AgentChatSnapshot,
    Principal,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import {
    agentChatMethods,
    canMobileAgentChatSend,
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
            | 'mobile.agentChat.configure'
            | 'mobile.agentChat.removeQueued'
            | 'mobile.agentChat.sendQueuedNow'
            | 'mobile.agentChat.resumeQueue'
            | 'mobile.agentChat.takeQueued';
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

/**
 * The root of the Chat Session's Project, which the phone's window and patches name changed files against so they read
 * as Desktop names them (`src/app.ts`) without the phone learning the root itself.
 */
async function agentChatProjectRoot(
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
): Promise<string> {
    const { rootPath } = await domainService.request('mobile.session.projectRootInternal', {
        sessionId,
        principal,
    });
    return rootPath;
}

/**
 * The Project root for an Agent Chat subscription, resolved through the device's grant like `mobile.agentChat.read`.
 */
export async function agentChatTerminalProjectRoot(
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
): Promise<string> {
    const terminal = await agentChatTerminalForPrincipal(domainService, principal, terminalId);
    return agentChatProjectRoot(domainService, principal, terminal.sessionId);
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
): Promise<
    | AgentChatSnapshot
    | (ImageData & { chunkIndex: number; chunkCount: number })
    | { text: string }
    | null
> {
    if (!forwardOperation)
        throw new CaxriError('UNAVAILABLE', 'Agent Chat is unavailable to paired devices');
    const forward = forwardOperation;
    const { terminalId } = request.params;
    const terminal = await agentChatTerminalForPrincipal(domainService, principal, terminalId);
    reauthorize();
    switch (request.method) {
        case 'mobile.agentChat.read': {
            const [snapshot, projectRoot] = await Promise.all([
                domainService.request('agentChat.read', { terminalId }),
                agentChatProjectRoot(domainService, principal, terminal.sessionId),
            ]);
            reauthorize();
            return windowAgentChatSnapshotForMobile(snapshot, projectRoot);
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
             * A message sent during a turn waits in the follow-up queue by default, as Desktop's Enter does; the phone
             * sees the queue as a read-only preview in its snapshot. `steer` stays available for the phone's explicit
             * "Steer now" action.
             */
            const { delivery } = request.params;
            await forward({
                method: 'agentChat.send',
                params: {
                    terminalId,
                    text: request.params.text,
                    ...(images.length > 0 && { images }),
                    ...(delivery && { delivery }),
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
            const { permissionMode, planMode } = request.params;
            /**
             * A permission level decides which actions the Agent may take without asking, so changing it is the
             * standing form of answering approvals, which only a `control` device may do (`mobile.agentChat.respond`).
             * Plan mode travels with it, as one Permissions sheet. A `reply` device keeps the model and effort.
             */
            if (
                (permissionMode !== undefined || planMode !== undefined) &&
                principal.role !== 'control'
            )
                throw new CaxriError(
                    'FORBIDDEN',
                    'Control access is required to change permissions',
                );
            /**
             * Core validates the switch against the Chat's listed models (`resolveAgentChatModelChange`), so a phone
             * holding a stale list cannot choose a model or effort the provider never offered, nor turn on ultracode
             * for a model without it; a permission level or plan mode the provider lacks fails the same way
             * (`resolveAgentChatPermissionChange`).
             */
            await forward({
                method: 'agentChat.configure',
                params: {
                    terminalId,
                    ...(request.params.model !== undefined && { model: request.params.model }),
                    ...(request.params.effort !== undefined && { effort: request.params.effort }),
                    ...(request.params.ultracode !== undefined && {
                        ultracode: request.params.ultracode,
                    }),
                    ...(permissionMode !== undefined && { permissionMode }),
                    ...(planMode !== undefined && { planMode }),
                },
            });
            return null;
        }
        /**
         * The Desktop queue card's actions. Core owns the queue and its rules (a command cannot steer a running turn, a
         * message that already left the queue is a `CONFLICT`), so the phone forwards the id and nothing else.
         */
        case 'mobile.agentChat.removeQueued': {
            await forward({
                method: 'agentChat.removeQueued',
                params: { terminalId, id: request.params.id },
            });
            return null;
        }
        case 'mobile.agentChat.sendQueuedNow': {
            await forward({
                method: 'agentChat.sendQueuedNow',
                params: { terminalId, id: request.params.id },
            });
            return null;
        }
        case 'mobile.agentChat.resumeQueue': {
            await forward({ method: 'agentChat.resumeQueue', params: { terminalId } });
            return null;
        }
        case 'mobile.agentChat.takeQueued': {
            /**
             * The full text is checked before Core takes the message, so one the phone could not send again stays
             * queued for Desktop. Queued text never changes, so this read cannot disagree with the take; a message that
             * leaves the queue in between still fails the take with `CONFLICT`.
             */
            const { id } = request.params;
            const { queue } = await domainService.request('agentChat.read', { terminalId });
            const entry = queue?.find((candidate) => candidate.id === id);
            if (!entry) throw new CaxriError('CONFLICT', 'This message is no longer queued');
            if (!canMobileAgentChatSend(entry.text))
                throw new CaxriError('VALIDATION', 'This message is too long to edit on a phone');
            reauthorize();
            const taken = agentChatMethods['agentChat.takeQueued'].result.parse(
                await forward({ method: 'agentChat.takeQueued', params: { terminalId, id } }),
            );
            return { text: taken.text };
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
