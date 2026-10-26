import { z } from 'zod';

import type {
    CommanderInbox,
    CommanderInboxItem,
} from '../agent/commander/agent-commander-inbox-contract.js';
import {
    commanderInboxItemSchema,
    commanderInboxMethods,
    MAX_COMMANDER_INBOX_OPEN_ITEMS,
} from '../agent/commander/agent-commander-inbox-contract.js';
import { orderCommanderInboxItems } from '../agent/commander/agent-commander-inbox-presentation.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

/**
 * A mobile reply must fit one sealed gateway frame (64 KiB of plaintext), while the Inbox may hold 200 open items with
 * 16 KiB bodies each. The phone therefore reads the open items that fit this budget, each shortened, with room left for
 * the envelope.
 */
export const MOBILE_COMMANDER_INBOX_MAX_BYTES = 48 * 1_024;
export const MOBILE_COMMANDER_INBOX_MAX_ITEMS = 50;
export const MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH = 4_000;
export const MOBILE_COMMANDER_INBOX_REPLY_MAX_LENGTH = 1_000;
/**
 * Newest replies a card shows; older ones are counted in `earlierReplyCount`. The latest reply is always kept, so the
 * read state ("Delivered to Commander" or "Read by Commander") is computed from the same sequence Desktop uses.
 */
export const MOBILE_COMMANDER_INBOX_MAX_REPLIES = 5;
const CLIP_MARKER = '…';

const clipHead = (text: string, limit: number): { text: string; isClipped: boolean } =>
    text.length <= limit
        ? { text, isClipped: false }
        : { text: `${text.slice(0, limit)}\n${CLIP_MARKER}`, isClipped: true };

const mobileCommanderInboxReplySchema = z.strictObject({
    sequence: z.number().int().positive(),
    body: z
        .string()
        .min(1)
        .max(MOBILE_COMMANDER_INBOX_REPLY_MAX_LENGTH + 2),
    createdAt: z.number(),
});

/**
 * One open Inbox item as the phone renders it. Merge-only fields (verified head, live GitHub state, revision) are left
 * out because the phone cannot merge; it shows the pull request as a `repo#number` link.
 */
export const mobileCommanderInboxItemSchema = z.strictObject({
    id: commanderInboxItemSchema.shape.id,
    kind: commanderInboxItemSchema.shape.kind,
    staleReason: commanderInboxItemSchema.shape.staleReason,
    title: commanderInboxItemSchema.shape.title,
    body: z.string().max(MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH + 2),
    isBodyClipped: z.boolean(),
    options: commanderInboxItemSchema.shape.options,
    pullRequest: z
        .strictObject({
            url: z.string().max(512),
            repo: z.string().min(1).max(100),
            number: z.number().int().positive(),
        })
        .optional(),
    replies: z.array(mobileCommanderInboxReplySchema).max(MOBILE_COMMANDER_INBOX_MAX_REPLIES),
    earlierReplyCount: z.number().int().nonnegative(),
    acknowledgedSequence: commanderInboxItemSchema.shape.acknowledgedSequence,
    updatedAt: z.number(),
});

export const mobileCommanderInboxListResultSchema = z.strictObject({
    items: z.array(mobileCommanderInboxItemSchema).max(MOBILE_COMMANDER_INBOX_MAX_ITEMS),
    /**
     * Every open item, including any that did not fit this reply.
     */
    total: z.number().int().nonnegative().max(MAX_COMMANDER_INBOX_OPEN_ITEMS),
    truncated: z.boolean(),
});

const mobileCommanderInboxReplyParametersSchema =
    commanderInboxMethods['commander.inbox.reply'].params;
const mobileCommanderInboxReplyResultSchema = z.strictObject({
    sequence: z.number().int().positive(),
});

export type MobileCommanderInboxItem = z.infer<typeof mobileCommanderInboxItemSchema>;
export type MobileCommanderInboxListResult = z.infer<typeof mobileCommanderInboxListResultSchema>;

const byteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

function projectItem(item: CommanderInboxItem): MobileCommanderInboxItem {
    const body = clipHead(item.body, MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH);
    const replies = item.replies.slice(-MOBILE_COMMANDER_INBOX_MAX_REPLIES);
    return {
        id: item.id,
        kind: item.kind,
        ...(item.staleReason && { staleReason: item.staleReason }),
        title: item.title,
        body: body.text,
        isBodyClipped: body.isClipped,
        options: item.options,
        ...(item.pullRequest && {
            pullRequest: {
                url: item.pullRequest.url,
                repo: item.pullRequest.repo,
                number: item.pullRequest.number,
            },
        }),
        replies: replies.map((reply) => ({
            sequence: reply.sequence,
            body: clipHead(reply.body, MOBILE_COMMANDER_INBOX_REPLY_MAX_LENGTH).text,
            createdAt: reply.createdAt,
        })),
        earlierReplyCount: item.replies.length - replies.length,
        acknowledgedSequence: item.acknowledgedSequence,
        updatedAt: item.updatedAt,
    };
}

/**
 * The open items a phone can carry in one frame, questions first (see `orderCommanderInboxItems`), so a pull request is
 * the first thing dropped when the budget runs out. `truncated` tells the phone some open items are only on Desktop.
 */
export function projectCommanderInboxForMobile(
    inbox: CommanderInbox,
): MobileCommanderInboxListResult {
    const open = orderCommanderInboxItems(inbox.items.filter((item) => item.status === 'open'));
    const items: MobileCommanderInboxItem[] = [];
    let budget =
        MOBILE_COMMANDER_INBOX_MAX_BYTES -
        byteLength({ items: [], total: open.length, truncated: true });
    for (const item of open) {
        if (items.length >= MOBILE_COMMANDER_INBOX_MAX_ITEMS) break;
        const projected = projectItem(item);
        const cost = byteLength(projected) + 1;
        if (cost > budget) break;
        budget -= cost;
        items.push(projected);
    }
    return { items, total: open.length, truncated: items.length < open.length };
}

/**
 * The Commander Inbox from a paired device: read the open items and reply to one. Merge and Dismiss stay on Desktop.
 */
export const mobileCommanderInboxMethods = {
    'mobile.commanderInbox.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}).default({}),
        result: mobileCommanderInboxListResultSchema,
    },
    'mobile.commanderInbox.reply': {
        ...commandPolicy('server', 'write', ['terminals.steer']),
        params: mobileCommanderInboxReplyParametersSchema,
        result: mobileCommanderInboxReplyResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const mobileCommanderInboxInternalMethods = {
    'mobile.commanderInbox.replyInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileCommanderInboxReplyParametersSchema.extend({ principal: principalSchema }),
        result: mobileCommanderInboxReplyResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
