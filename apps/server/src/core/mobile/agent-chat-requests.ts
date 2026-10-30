import type {
    AgentChatContinuationTarget,
    AgentChatHistoryPage,
    AgentChatImageMediaType,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentChatTaskSnapshot,
    AgentUsageReadout,
    Principal,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import {
    agentChatMethods,
    agentChatQueuedTextAfterEdit,
    agentChatQueuedTextEdit,
    canMobileAgentChatSend,
    CaxriError,
    clipAgentChatTaskSnapshotForMobile,
    MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH,
    readMobileMessageChunk,
    windowAgentChatHistoryPageForMobile,
    windowAgentChatSnapshotForMobile,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { terminalForPrincipal } from './action-requests';

/**
 * Every phone Chat method. The access controller routes the whole namespace here, so a new `mobile.agentChat.*` method
 * only needs its case in `invokeMobileAgentChatRequest`.
 */
export type MobileAgentChatRequest = Extract<
    ServerRequest,
    { method: `mobile.agentChat.${string}` }
>;

export const isMobileAgentChatRequest = (
    request: ServerRequest,
): request is MobileAgentChatRequest => request.method.startsWith('mobile.agentChat.');

/**
 * A read needs no mutation authority; the access controller invokes it without serializing behind a revoke.
 */
const mobileAgentChatReads: ReadonlySet<MobileAgentChatRequest['method']> = new Set([
    'mobile.agentChat.read',
    'mobile.agentChat.requests',
    'mobile.agentChat.readImage',
    'mobile.agentChat.readTask',
    'mobile.agentChat.readHistory',
    'mobile.agentChat.readUsage',
    'mobile.agentChat.readMessage',
    'mobile.agentChat.continuationTargets',
]);

export const isMobileAgentChatRead = (request: MobileAgentChatRequest): boolean =>
    mobileAgentChatReads.has(request.method);

/**
 * One entry of the Chat's follow-up queue with its full text; a message that already left the queue is a `CONFLICT`.
 */
async function queuedEntry(domainService: ServerDomainService, terminalId: string, id: string) {
    const { queue } = await domainService.request('agentChat.read', { terminalId });
    const entry = queue?.find((candidate) => candidate.id === id);
    if (!entry) throw new CaxriError('CONFLICT', 'This message is no longer queued');
    return entry;
}

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

/**
 * Registers a phone's Agent Chat subscription so idle suspension leaves the Chat running, and returns the release the
 * subscription calls when it closes.
 */
export async function beginMobileAgentChatWatch(
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
): Promise<() => void> {
    await agentChatTerminalForPrincipal(domainService, principal, terminalId);
    await domainService.request('mobile.chatWatch.watchInternal', { terminalId });
    return () => {
        void domainService
            .request('mobile.chatWatch.unwatchInternal', { terminalId })
            .catch(() => {});
    };
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

/**
 * The thumbnail a projection item carries, `null` when it has none, or `undefined` when the item already left the
 * projection (a message the phone read through `mobile.agentChat.readHistory`).
 */
function thumbnailOf(
    snapshot: AgentChatSnapshot,
    itemId: string,
    index: number,
): ImageData | null | undefined {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    const thumbnail = item.type === 'userMessage' ? item.images?.[index]?.thumbnail : undefined;
    const match = thumbnail ? THUMBNAIL_PATTERN.exec(thumbnail) : null;
    return match ? { mediaType: match[1] as AgentChatImageMediaType, data: match[2] } : null;
}

/**
 * The page of history before `beforeItemId` as Core holds it, before it is cut to one mobile frame. The phone's window
 * shows only the newest part of the projection, so its first cursor usually names an item inside the projection, which
 * `agentChat.readHistory` does not page from (it starts at the projection's first item). Those projection items are
 * paged here, oldest-last; once the cursor reaches the projection's first item, or an archived or recorded item, Core's
 * own history paging takes over.
 */
async function agentChatHistoryPageBefore(
    domainService: ServerDomainService,
    terminalId: string,
    beforeItemId: string,
): Promise<AgentChatHistoryPage> {
    const snapshot = await domainService.request('agentChat.read', { terminalId });
    const end = snapshot.items.findIndex((item) => item.id === beforeItemId);
    if (end <= 0)
        return domainService.request('agentChat.readHistory', { terminalId, beforeItemId });
    const items = snapshot.items.slice(0, end);
    const turnIds = new Set(items.map((item) => item.turnId));
    return {
        historyId: snapshot.historyId ?? '',
        items,
        turns: snapshot.turns.filter((turn) => turnIds.has(turn.id)),
        /**
         * The mobile window keeps the newest of these and sets `hasMore` when it drops any; past the projection, more
         * follows exactly when the projection itself is truncated.
         */
        hasMore: snapshot.truncated === true,
        truncated: false,
    };
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
    | AgentChatHistoryPage
    | AgentChatTaskSnapshot
    | AgentUsageReadout
    | (ImageData & { chunkIndex: number; chunkCount: number })
    | { requests: AgentChatRequest[] }
    | { text: string }
    | { text: string; imageCount: number; hasReferences: boolean }
    | { sessionId: string; terminalId?: string }
    | { targets: AgentChatContinuationTarget[] }
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
        case 'mobile.agentChat.requests': {
            // Only the in-memory waiting list: `agentChat.read` would start the provider of an idle Chat.
            const { entries } = await domainService.request('agentChat.pendingRequests', {});
            reauthorize();
            const entry = entries.find(
                (candidate) => candidate.kind === 'chat' && candidate.terminalId === terminalId,
            );
            return { requests: entry?.kind === 'chat' ? entry.requests : [] };
        }
        case 'mobile.agentChat.readHistory': {
            const [page, projectRoot] = await Promise.all([
                agentChatHistoryPageBefore(domainService, terminalId, request.params.beforeItemId),
                agentChatProjectRoot(domainService, principal, terminal.sessionId),
            ]);
            reauthorize();
            return windowAgentChatHistoryPageForMobile(page, projectRoot);
        }
        case 'mobile.agentChat.readImage': {
            const { itemId, index, variant, chunkIndex } = request.params;
            /**
             * Core keeps no lookup for an older message's thumbnail, so a thumbnail of an item outside the projection
             * falls back to the original from the provider's record; slower, but the image still shows.
             */
            const thumbnail =
                variant === 'thumbnail'
                    ? thumbnailOf(
                          await domainService.request('agentChat.read', { terminalId }),
                          itemId,
                          index,
                      )
                    : undefined;
            const image =
                thumbnail === undefined
                    ? await readOriginal(domainService, { terminalId, itemId, index })
                    : thumbnail;
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
        /**
         * The Background work sheet's detail and Stop. Core resolves the task within this Chat, so a task id from
         * another Chat fails there with `NOT_FOUND`; a subagent's rows name files like the Chat's own.
         */
        case 'mobile.agentChat.readTask': {
            const [task, projectRoot] = await Promise.all([
                domainService.request('agentChat.readTask', {
                    terminalId,
                    taskId: request.params.taskId,
                }),
                agentChatProjectRoot(domainService, principal, terminal.sessionId),
            ]);
            reauthorize();
            return clipAgentChatTaskSnapshotForMobile(task, projectRoot);
        }
        case 'mobile.agentChat.readUsage': {
            const readout = await domainService.request('terminal.agentUsage', { terminalId });
            reauthorize();
            return readout;
        }
        case 'mobile.agentChat.dismissPlanPace': {
            if (!terminal.provider)
                throw new CaxriError('CONFLICT', 'This Chat has no Agent provider yet');
            await forward({
                method: 'usage.dismissNotice',
                params: { provider: terminal.provider, notice: 'planPace' },
            });
            return null;
        }
        case 'mobile.agentChat.stopTask': {
            await forward({
                method: 'agentChat.stopTask',
                params: { terminalId, taskId: request.params.taskId },
            });
            return null;
        }
        case 'mobile.agentChat.implementPlan': {
            await forward({
                method: 'agentChat.implementPlan',
                params: { terminalId, itemId: request.params.itemId },
            });
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
            const entry = await queuedEntry(domainService, terminalId, id);
            if (!canMobileAgentChatSend(entry.text))
                throw new CaxriError('VALIDATION', 'This message is too long to edit on a phone');
            reauthorize();
            const taken = agentChatMethods['agentChat.takeQueued'].result.parse(
                await forward({ method: 'agentChat.takeQueued', params: { terminalId, id } }),
            );
            return { text: taken.text };
        }
        case 'mobile.agentChat.readQueued': {
            const entry = await queuedEntry(domainService, terminalId, request.params.id);
            reauthorize();
            if (!canMobileAgentChatSend(entry.text))
                throw new CaxriError('VALIDATION', 'This message is too long to edit on a phone');
            const { prefix, body } = agentChatQueuedTextEdit(entry.text);
            return { text: body, imageCount: entry.imageCount ?? 0, hasReferences: prefix !== '' };
        }
        case 'mobile.agentChat.editQueued': {
            /**
             * The phone sends only what the user typed. The message's own reference block is read here and put back
             * ahead of it, so the references stay attached and a phone never composes the serialized block.
             */
            const { id, text } = request.params;
            const entry = await queuedEntry(domainService, terminalId, id);
            reauthorize();
            const { prefix } = agentChatQueuedTextEdit(entry.text);
            await forward({
                method: 'agentChat.editQueued',
                params: { terminalId, id, text: agentChatQueuedTextAfterEdit(prefix, text) },
            });
            return null;
        }
        case 'mobile.agentChat.readMessage': {
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            reauthorize();
            const item = snapshot.items.find((candidate) => candidate.id === request.params.itemId);
            if (item?.type !== 'userMessage' && item?.type !== 'agentMessage')
                throw new CaxriError('NOT_FOUND', 'This message is no longer in the Chat');
            const text =
                item.type === 'userMessage' ? agentChatQueuedTextEdit(item.text).body : item.text;
            return readMobileMessageChunk(text, request.params.offset);
        }
        case 'mobile.agentChat.rewind': {
            /**
             * Checked here as well as in Core so a message with images is refused rather than resent without them: its
             * images stay on Server Core and the phone has no way to put them back into an edit, as on Desktop.
             */
            const { itemId, text } = request.params;
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            reauthorize();
            const item = snapshot.items.find((candidate) => candidate.id === itemId);
            if (item?.type !== 'userMessage')
                throw new CaxriError('CONFLICT', 'This message is no longer in the Chat');
            if ((item.images?.length ?? 0) > 0)
                throw new CaxriError('CONFLICT', 'A message with images cannot be edited');
            const { prefix } = agentChatQueuedTextEdit(item.text);
            await forward({
                method: 'agentChat.rewind',
                params: {
                    terminalId,
                    itemId,
                    restoreFiles: false,
                    text: agentChatQueuedTextAfterEdit(prefix, text),
                },
            });
            return null;
        }
        case 'mobile.agentChat.runCommand': {
            // Core checks the name against the Chat's listed commands, so a phone's stale list cannot run another.
            const { name, arguments: arguments_ } = request.params;
            await forward({
                method: 'agentChat.runCommand',
                params: {
                    terminalId,
                    name,
                    ...(arguments_ !== undefined && { arguments: arguments_ }),
                },
            });
            return null;
        }
        case 'mobile.agentChat.fork': {
            const forked = agentChatMethods['agentChat.fork'].result.parse(
                await forward({ method: 'agentChat.fork', params: { terminalId } }),
            );
            return { sessionId: forked.sessionId, terminalId: forked.terminalId };
        }
        case 'mobile.agentChat.continuationTargets': {
            const { targets } = await domainService.request('agentChat.continuationTargets', {
                terminalId,
            });
            reauthorize();
            return { targets };
        }
        case 'mobile.agentChat.continueInAgent': {
            /**
             * Always the menu's `manual` continuation: the phone has no usage-limit card, and `manual` refuses a
             * running turn instead of handing over work still in progress.
             */
            const continued = agentChatMethods['agentChat.continueInAgent'].result.parse(
                await forward({
                    method: 'agentChat.continueInAgent',
                    params: { terminalId, provider: request.params.provider, manual: true },
                }),
            );
            return { sessionId: continued.sessionId };
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
