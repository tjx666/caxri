import { z } from 'zod';

import {
    agentChatImageMediaTypeSchema,
    agentChatSnapshotSchema,
} from '../agent/agent-chat-contract.js';
import { MAX_AGENT_CHAT_IMAGES } from '../agent/agent-chat-limits.js';
import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { agentChatHistoryPageSchema } from '../agent/agent-chat-patch-contract.js';
import { agentChatTaskSnapshotSchema } from '../agent/agent-chat-task-contract.js';
import { identifierSchema } from '../domain/identifiers.js';
import { agentUsageReadoutSchema, usageNoticeSchema } from '../domain/usage-contract.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    mobileAgentChatImplementPlanMethod,
    mobileAgentChatRequestsMethod,
} from './mobile-agent-chat-requests-contract.js';
import {
    MAX_MOBILE_FILE_ATTACHMENTS,
    mobileFileAttachmentIdSchema,
} from './mobile-file-upload-contract.js';
import { mobileAttachmentIdSchema } from './mobile-image-contract.js';
import {
    mobileMessageChunkSchema,
    mobileMessageOffsetSchema,
} from './mobile-message-read-contract.js';

const MOBILE_AGENT_CHAT_SEND_MAX_BYTES = 16 * 1_024;

/**
 * Whether `text` fits one `mobile.agentChat.send`. A queued message the phone takes back for editing must pass the same
 * bound, or the phone could not send it again.
 */
export const canMobileAgentChatSend = (text: string): boolean =>
    new TextEncoder().encode(text).length <= MOBILE_AGENT_CHAT_SEND_MAX_BYTES;

/**
 * Base64 characters one `mobile.agentChat.readImage` reply carries, so an original of several megabytes arrives as a
 * series of replies that each fit one gateway frame.
 */
export const MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH = 45_000;

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
    'mobile.agentChat.requests': mobileAgentChatRequestsMethod,
    'mobile.agentChat.implementPlan': mobileAgentChatImplementPlanMethod,
    /**
     * The page of history right before `beforeItemId`, the oldest item the phone holds (its window's first item, or the
     * first item of the last page read), cut to one mobile frame by `windowAgentChatHistoryPageForMobile`. The Server
     * pages first through the projection items older than the phone's window, then forwards to `agentChat.readHistory`.
     * Item ids are the cursor, so a page never repeats or skips an item the window moved past.
     */
    'mobile.agentChat.readHistory': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            ...terminalTarget,
            beforeItemId: agentChatMethods['agentChat.readHistory'].params.shape.beforeItemId,
        }),
        result: agentChatHistoryPageSchema,
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
                    canMobileAgentChatSend,
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
                /**
                 * Uploaded files (`mobile.file.upload`) that `text` cites by path ahead of the user's words, the way
                 * Desktop cites a file dropped from Finder (`agentChatTextWithPathReferences`). The Server refuses the
                 * message when one has expired or `text` does not cite it, so the Agent never reads a missing file.
                 */
                files: z
                    .array(mobileFileAttachmentIdSchema)
                    .max(MAX_MOBILE_FILE_ATTACHMENTS)
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
    /**
     * `terminal.agentUsage` for the phone: the conversation's tokens and estimated cost for the Session usage sheet,
     * and the provider's plan rate limits (`5h 62% · 7d 28%`) for the model sheet and the pace reminder. `null` until
     * the conversation recorded any usage; `limit` stays absent until the provider reported one.
     */
    'mobile.agentChat.readUsage': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(terminalTarget),
        result: agentUsageReadoutSchema.nullable(),
    },
    /**
     * The phone's close button on a plan notice: `usage.dismissNotice` for the Chat's provider, so the pace reminder
     * stays hidden for the day (the credits notice for a day) on this phone after a relaunch and on Desktop too. It
     * only hides a notice, so every role that may read the limit may dismiss it.
     */
    'mobile.agentChat.dismissUsageNotice': {
        ...commandPolicy('server', 'write', ['sessions.read']),
        params: z.strictObject({ ...terminalTarget, notice: usageNoticeSchema }),
        result: z.null(),
    },
    /**
     * The usage-limit card's Continue now (or Continue, once the reset passed) and Cancel, forwarded to
     * `agentChat.usageLimitWait`. Continuing starts the Chat's next turn as sending would, so it carries the sending
     * grant; Cancel rides with it.
     */
    'mobile.agentChat.usageLimitWait': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.usageLimitWait'].params,
        result: z.null(),
    },
    /**
     * The usage guard card's Generate hand-off, forwarded to `agentChat.generateHandoff`: this Chat's own model writes
     * a hand-off document on the budget the guard kept, once per account and weekly window. The document lands on the
     * snapshot's `usageGuard.document`.
     */
    'mobile.agentChat.generateHandoff': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    /**
     * The usage guard card's Continue anyway, forwarded to `agentChat.bypassUsageGuard`: admits the account's requests
     * for the rest of the guard's weekly window.
     */
    'mobile.agentChat.bypassUsageGuard': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    'mobile.agentChat.interrupt': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    /**
     * One background task's detail for the phone's Background work sheet: a shell's output tail or a subagent's newest
     * messages, forwarded to `agentChat.readTask` and cut to one frame (`clipAgentChatTaskSnapshotForMobile`). The
     * phone polls it while the detail is open instead of subscribing to `agentChat.taskPatch`.
     */
    'mobile.agentChat.readTask': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: agentChatMethods['agentChat.readTask'].params,
        result: agentChatTaskSnapshotSchema,
    },
    /**
     * Stops one running background task without ending the turn or the Chat, the Desktop strip's Stop. Control access,
     * like `mobile.agentChat.interrupt`.
     */
    'mobile.agentChat.stopTask': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.stopTask'].params,
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
    /**
     * Runs one of the snapshot's `commands`, the phone's equivalent of choosing it from the Desktop composer's `/`
     * menu. Forwarded to `agentChat.runCommand`, which refuses a command the provider does not list and queues one
     * issued during a turn. Arguments share a phone message's 16 KiB bound.
     */
    'mobile.agentChat.runCommand': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            ...terminalTarget,
            name: agentChatMethods['agentChat.runCommand'].params.shape.name,
            arguments: agentChatMethods['agentChat.runCommand'].params.shape.arguments.refine(
                (value) => value === undefined || canMobileAgentChatSend(value),
                'Mobile Chat messages must be at most 16 KiB',
            ),
        }),
        result: z.null(),
    },
    /**
     * Takes a queued follow-up back for editing and returns its full text, which the snapshot's preview cuts to 200
     * characters: the phone's equivalent of the Desktop queue card's Edit, forwarded to `agentChat.takeQueued`. A text
     * over the 16 KiB a phone may send stays queued and fails with `VALIDATION`, as does a message carrying images.
     */
    'mobile.agentChat.takeQueued': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.takeQueued'].params,
        result: z.strictObject({
            text: agentChatMethods['agentChat.takeQueued'].result.shape.text.refine(
                canMobileAgentChatSend,
                'Mobile Chat messages must be at most 16 KiB',
            ),
        }),
    },
    /**
     * Reads what the phone's Edit of a queued follow-up needs and changes nothing: the full text the user typed (the
     * file, folder, and skill references a message carries ahead of it are left out, since the phone's composer has no
     * place for them) and how many images ride with the message. A message with images or references is edited in place
     * through `mobile.agentChat.editQueued`; any other is taken back into the draft by `mobile.agentChat.takeQueued`. A
     * text over the 16 KiB a phone may send fails with `VALIDATION`; a message that already left the queue fails with
     * `CONFLICT`.
     */
    'mobile.agentChat.readQueued': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.takeQueued'].params,
        result: z.strictObject({
            text: agentChatMethods['agentChat.takeQueued'].result.shape.text.refine(
                canMobileAgentChatSend,
                'Mobile Chat messages must be at most 16 KiB',
            ),
            imageCount: z.number().int().nonnegative(),
            hasReferences: z.boolean(),
        }),
    },
    /**
     * Rewrites the text the user typed in a queued follow-up where it stands, keeping its images, its references, and
     * its place in the queue: the phone's Edit of a message whose images or references cannot return to a composer,
     * forwarded to `agentChat.editQueued` with the message's own reference block put back ahead of `text`. A message
     * left with no text and no images, or a command, fails with `VALIDATION`.
     */
    'mobile.agentChat.editQueued': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            ...agentChatMethods['agentChat.takeQueued'].params.shape,
            text: agentChatMethods['agentChat.editQueued'].params.shape.text.refine(
                canMobileAgentChatSend,
                'Mobile Chat messages must be at most 16 KiB',
            ),
        }),
        result: z.null(),
    },
    /**
     * The whole text of one message for the phone's Copy and Select Text, since its window keeps only the tail of a
     * long one (`clipAgentChatItemForMobile`): a reply's Markdown source, or the words a user message's sender typed
     * without the reference block its file chips stand for. The text arrives in slices (`offset`, `nextOffset`) that
     * each fit one gateway frame, and has its own bound, `MOBILE_MESSAGE_READ_MAX_BYTES`, not the 16 KiB a phone may
     * send. Only a message still in Core's projection is found; another fails with `NOT_FOUND`, and one over the bound
     * fails with `VALIDATION`.
     */
    'mobile.agentChat.readMessage': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            ...terminalTarget,
            itemId: z.string().min(1).max(200),
            offset: mobileMessageOffsetSchema,
        }),
        result: mobileMessageChunkSchema,
    },
    /**
     * The phone's "Edit from here", forwarded to `agentChat.rewind`: rewinds the conversation to just before user
     * message `itemId` and sends `text` in its place, with the message's own reference block put back ahead of it as
     * `mobile.agentChat.editQueued` does. The phone never restores files; a running turn, a message with images, or one
     * that did not start its turn fails with `CONFLICT` before anything changes.
     */
    'mobile.agentChat.rewind': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            ...terminalTarget,
            itemId: z.string().min(1).max(200),
            text: z
                .string()
                .min(1)
                .refine(canMobileAgentChatSend, 'Mobile Chat messages must be at most 16 KiB'),
        }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
