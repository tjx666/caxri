import { z } from 'zod';

import type {
    AgentChatItem,
    AgentChatPatch,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from '../agent/agent-chat-contract.js';
import {
    agentChatImageMediaTypeSchema,
    agentChatSnapshotSchema,
    MAX_AGENT_CHAT_IMAGES,
} from '../agent/agent-chat-contract.js';
import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { identifierSchema } from '../domain/domain.js';
import { projectDisplayPath } from '../domain/project-path.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { mobileAttachmentIdSchema } from './mobile-image-contract.js';

/**
 * A mobile reply or event must fit one sealed gateway frame (64 KiB of plaintext), while a Desktop Chat projection may
 * hold megabytes. The phone therefore reads a window of the newest items and receives patches only when they fit; both
 * stay under this budget with room for the envelope.
 */
export const MOBILE_AGENT_CHAT_MAX_BYTES = 48 * 1_024;

/**
 * Longest text a single mobile item field keeps. Messages and output keep their tail so streamed `appendText` deltas
 * still continue the shortened text; a diff keeps its head, which is where a reader starts.
 */
export const MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH = 4_000;

/**
 * Marks where the phone's copy of an item was shortened. Visible in the transcript so a clipped reply never reads as
 * the whole reply.
 */
export const MOBILE_AGENT_CHAT_CLIP_MARKER = '…';

const MOBILE_AGENT_CHAT_SEND_MAX_BYTES = 16 * 1_024;

/**
 * Base64 characters one `mobile.agentChat.readImage` reply carries, so an original of several megabytes arrives as a
 * series of replies that each fit one gateway frame.
 */
export const MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH = 45_000;

/**
 * The phone shows the follow-up queue as a short read-only list above its composer, so it receives at most this many
 * queued messages, each cut to a one-glance preview. The whole queue (up to `MAX_AGENT_CHAT_QUEUE` messages of
 * `MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH` text) could exceed a frame on its own; these bounds keep it to a few KiB.
 */
export const MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS = 10;
export const MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH = 200;

const keepTail = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${MOBILE_AGENT_CHAT_CLIP_MARKER}${text.slice(-limit)}`;

const keepHead = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}\n${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

/**
 * A file change's paths as Desktop names them, Project-relative inside the Session's Project. The Server relativizes
 * them because a paired device is never told a Project's root path (`scopedProjectSchema`).
 */
function withProjectPaths(item: AgentChatItem, projectRoot: string | undefined): AgentChatItem {
    if (projectRoot === undefined || item.type !== 'fileChange') return item;
    const changes = item.changes.map((change) => {
        const path = projectDisplayPath(change.path, projectRoot);
        return path === change.path ? change : { ...change, path };
    });
    return changes.some((change, index) => change !== item.changes[index])
        ? { ...item, changes }
        : item;
}

/**
 * Shortens one item to what a phone can carry, naming changed files relative to `projectRoot`, the Session's Project
 * root. Deterministic, so the snapshot window and later `upsertItem` patches agree on the same item.
 */
export function clipAgentChatItemForMobile(
    original: AgentChatItem,
    projectRoot?: string,
): AgentChatItem {
    const item = withProjectPaths(original, projectRoot);
    switch (item.type) {
        case 'userMessage': {
            const text =
                item.text.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                    ? item.text
                    : keepTail(item.text);
            /**
             * A Desktop thumbnail may take 48 KiB, so a few would fill the whole frame and push the message and all
             * older history out of the window. The phone keeps each image's place and fetches its thumbnail on demand
             * through `mobile.agentChat.readImage`.
             */
            const hasThumbnail =
                item.images?.some((image) => image.thumbnail !== undefined) ?? false;
            if (!hasThumbnail && text === item.text) return item;
            return {
                ...item,
                text,
                ...(item.images && { images: item.images.map(() => ({})) }),
            };
        }
        case 'agentMessage':
        case 'reasoning': {
            return item.text.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, text: keepTail(item.text) };
        }
        case 'command': {
            return item.output.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, output: keepTail(item.output) };
        }
        case 'toolCall': {
            return !item.output || item.output.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, output: keepTail(item.output) };
        }
        case 'fileChange': {
            // One budget for the whole item: later files keep their path and kind but lose their diff.
            let remaining = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH * 2;
            const changes = item.changes.map((change) => {
                const limit = Math.max(remaining, 0);
                remaining -= change.diff.length;
                if (change.diff.length <= limit) return change;
                return {
                    ...change,
                    diff: limit > 0 ? keepHead(change.diff, limit) : '',
                    truncated: true,
                };
            });
            return changes.some((change, index) => change !== item.changes[index])
                ? { ...item, changes }
                : item;
        }
        case 'notice': {
            return item;
        }
    }
}

const byteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The newest part of a Chat projection that fits one mobile frame. Older items are dropped first and `truncated` is
 * set, the same signal the Desktop projection uses for history it no longer holds.
 */
export function windowAgentChatSnapshotForMobile(
    full: AgentChatSnapshot,
    projectRoot?: string,
): AgentChatSnapshot {
    const snapshot = withoutDesktopOnlyState(full);
    const items = snapshot.items.map((item) => clipAgentChatItemForMobile(item, projectRoot));
    const activeTurnIds = (kept: readonly AgentChatItem[]) =>
        new Set([
            ...kept.map((item) => item.turnId).filter(Boolean),
            ...(snapshot.activeTurnId ? [snapshot.activeTurnId] : []),
        ]);
    const shell: AgentChatSnapshot = { ...snapshot, items: [], turns: [] };
    let budget = MOBILE_AGENT_CHAT_MAX_BYTES - byteLength(shell);
    let start = items.length;
    while (start > 0) {
        const cost = byteLength(items[start - 1]) + 1;
        if (cost > budget) break;
        budget -= cost;
        start -= 1;
    }
    const kept = items.slice(start);
    const turnIds = activeTurnIds(kept);
    const turns = snapshot.turns.filter((turn) => turnIds.has(turn.id));
    const windowed: AgentChatSnapshot = {
        ...snapshot,
        items: kept,
        turns,
        truncated: snapshot.truncated || start > 0,
    };
    // Turns are small but unbounded by the loop above; drop the oldest items again if they tipped the budget.
    while (windowed.items.length > 0 && byteLength(windowed) > MOBILE_AGENT_CHAT_MAX_BYTES) {
        windowed.items = windowed.items.slice(1);
        windowed.truncated = true;
    }
    return windowed;
}

const previewText = (text: string): string =>
    text.length <= MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH
        ? text
        : `${text.slice(0, MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH)}${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

type AgentChatQueue = NonNullable<AgentChatSnapshot['queue']>;

/**
 * The phone's copy of the follow-up queue: the first queued messages, in send order, each with a text preview and its
 * image count. Deterministic, so the snapshot window and later `state` patches agree.
 */
export function clipAgentChatQueueForMobile(queue: AgentChatQueue): AgentChatQueue {
    return queue.slice(0, MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS).map((message) => ({
        ...message,
        text: previewText(message.text),
        ...(message.command && {
            command: {
                name: message.command.name,
                ...(message.command.arguments !== undefined && {
                    arguments: previewText(message.command.arguments),
                }),
            },
        }),
    }));
}

/**
 * Background tasks are a Desktop surface the phone does not render yet, so they stay on the computer. The follow-up
 * queue travels as a bounded preview (see {@link clipAgentChatQueueForMobile}) with its paused flag and its real length,
 * which the preview alone cannot tell once the queue outgrows it.
 */
function withoutDesktopOnlyState<
    State extends Pick<Partial<AgentChatSnapshot>, 'queue' | 'queueLength' | 'tasks'>,
>(state: State): State {
    if (!state.tasks && !state.queue) return state;
    const rest = { ...state };
    delete rest.tasks;
    if (rest.queue) {
        rest.queueLength = rest.queue.length;
        rest.queue = clipAgentChatQueueForMobile(rest.queue);
    }
    return rest;
}

function clipOperation(
    operation: AgentChatPatchOperation,
    projectRoot: string | undefined,
): AgentChatPatchOperation {
    switch (operation.op) {
        case 'upsertItem': {
            return {
                op: 'upsertItem',
                item: clipAgentChatItemForMobile(operation.item, projectRoot),
            };
        }
        case 'state': {
            return { op: 'state', state: withoutDesktopOnlyState(operation.state) };
        }
        default: {
            return operation;
        }
    }
}

/**
 * The patch a phone receives, or `undefined` when even the shortened patch would not fit one frame. The gateway then
 * sends a content-free change notice and the phone re-reads its window instead.
 */
export function clipAgentChatPatchForMobile(
    patch: AgentChatPatch,
    projectRoot?: string,
): AgentChatPatch | undefined {
    const clipped: AgentChatPatch = {
        ...patch,
        operations: patch.operations.map((operation) => clipOperation(operation, projectRoot)),
    };
    return byteLength(clipped) <= MOBILE_AGENT_CHAT_MAX_BYTES ? clipped : undefined;
}

const terminalTarget = { terminalId: identifierSchema };

/**
 * Agent Chat from a paired device. Each method resolves the Terminal through the device's granted Projects before it
 * reaches the Chat service; see `docs/agent-chat.md`.
 */
export const mobileAgentChatMethods = {
    /**
     * The newest window of the Chat projection that fits one mobile frame. Starts or resumes the provider like
     * `agentChat.read`.
     */
    'mobile.agentChat.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(terminalTarget),
        result: agentChatSnapshotSchema,
    },
    /**
     * Sends a message, steering a running turn. Images do not travel inline, since one may be larger than a frame: the
     * phone first uploads each image and its thumbnail as JPEGs through `mobile.image.upload` under the Chat's Session,
     * then names them here.
     */
    'mobile.agentChat.send': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z
            .strictObject({
                ...terminalTarget,
                text: agentChatMethods['agentChat.send'].params.shape.text.refine(
                    (text) =>
                        new TextEncoder().encode(text).length <= MOBILE_AGENT_CHAT_SEND_MAX_BYTES,
                    'Mobile Chat messages must be at most 16 KiB',
                ),
                delivery: agentChatMethods['agentChat.send'].params.shape.delivery,
                attachments: z
                    .array(
                        z.strictObject({
                            attachmentId: mobileAttachmentIdSchema,
                            thumbnailAttachmentId: mobileAttachmentIdSchema,
                        }),
                    )
                    .max(MAX_AGENT_CHAT_IMAGES)
                    .optional(),
            })
            .refine(
                (message) => message.text.length > 0 || (message.attachments?.length ?? 0) > 0,
                { message: 'A message needs text or an image' },
            ),
        result: z.null(),
    },
    /**
     * One chunk of an image a user message carried: its thumbnail, or the original read from the provider's record like
     * `agentChat.readImage`. The phone's window drops thumbnails (see `clipAgentChatItemForMobile`), so it reads them
     * here as each message scrolls into view. Resolves `null` when no such image or thumbnail exists.
     */
    'mobile.agentChat.readImage': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            ...terminalTarget,
            itemId: agentChatMethods['agentChat.readImage'].params.shape.itemId,
            index: agentChatMethods['agentChat.readImage'].params.shape.index,
            variant: z.enum(['thumbnail', 'original']),
            chunkIndex: z.number().int().nonnegative().max(1_000).default(0),
        }),
        result: z
            .strictObject({
                mediaType: agentChatImageMediaTypeSchema,
                data: z
                    .string()
                    .max(MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH)
                    .regex(/^[\d+/A-Za-z]*={0,2}$/u),
                chunkIndex: z.number().int().nonnegative(),
                chunkCount: z.number().int().positive(),
            })
            .nullable(),
    },
    'mobile.agentChat.interrupt': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    'mobile.agentChat.respond': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.respond'].params,
        result: z.null(),
    },
    /**
     * Switches the model or reasoning effort the Chat's next turn uses, the phone's equivalent of the Desktop
     * composer's model menu. Core validates the change against the snapshot's `models`.
     */
    'mobile.agentChat.configure': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.configure'].params,
        result: z.null(),
    },
    /**
     * Restarts a failed Chat and resumes its bound conversation, the phone's equivalent of the Desktop pane's Retry.
     * Refused for any Terminal that is not a Chat.
     */
    'mobile.agentChat.retry': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    /**
     * Deletes a queued follow-up, the phone's equivalent of the Desktop queue card's Delete. The id comes from the
     * snapshot's bounded queue preview, which keeps every entry's real id. A message that already left the queue fails
     * with `CONFLICT`.
     */
    'mobile.agentChat.removeQueued': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.removeQueued'].params,
        result: z.null(),
    },
    /**
     * Sends a queued follow-up ahead of the rest: it steers the running turn, or starts a turn when the Chat is idle.
     * The Desktop queue card's Steer (or Send now).
     */
    'mobile.agentChat.sendQueuedNow': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.sendQueuedNow'].params,
        result: z.null(),
    },
    /**
     * Resumes a queue that Stop paused, the Desktop queue header's Resume.
     */
    'mobile.agentChat.resumeQueue': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.resumeQueue'].params,
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
