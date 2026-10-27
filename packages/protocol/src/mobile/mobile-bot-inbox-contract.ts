import { z } from 'zod';

import type { BotInbox, BotInboxItem } from '../agent/bot/caxri-bot-inbox-contract.js';
import {
    botInboxItemSchema,
    botInboxMethods,
    MAX_BOT_INBOX_OPEN_ITEMS,
} from '../agent/bot/caxri-bot-inbox-contract.js';
import { orderBotInboxItems } from '../agent/bot/caxri-bot-inbox-presentation.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

/**
 * A mobile reply must fit one sealed gateway frame (64 KiB of plaintext), while the Inbox may hold 200 open items with
 * 16 KiB bodies each. The phone therefore reads the open items that fit this budget, each shortened, with room left for
 * the envelope.
 */
export const MOBILE_BOT_INBOX_MAX_BYTES = 48 * 1_024;
export const MOBILE_BOT_INBOX_MAX_ITEMS = 50;
export const MOBILE_BOT_INBOX_BODY_MAX_LENGTH = 4_000;
export const MOBILE_BOT_INBOX_REPLY_MAX_LENGTH = 1_000;
/**
 * Newest replies a card shows; older ones are counted in `earlierReplyCount`. The latest reply is always kept, so the
 * read state ("Delivered to Caxri Bot" or "Read by Caxri Bot") is computed from the same sequence Desktop uses.
 */
export const MOBILE_BOT_INBOX_MAX_REPLIES = 5;
const CLIP_MARKER = '…';

const clipHead = (text: string, limit: number): { text: string; isClipped: boolean } =>
    text.length <= limit
        ? { text, isClipped: false }
        : { text: `${text.slice(0, limit)}\n${CLIP_MARKER}`, isClipped: true };

const mobileBotInboxReplySchema = z.strictObject({
    sequence: z.number().int().positive(),
    body: z
        .string()
        .min(1)
        .max(MOBILE_BOT_INBOX_REPLY_MAX_LENGTH + 2),
    createdAt: z.number(),
});

/**
 * One open Inbox item as the phone renders it. Merge-only fields (verified head, live GitHub state, revision) are left
 * out because the phone cannot merge; it shows the pull request as a `repo#number` link.
 */
export const mobileBotInboxItemSchema = z.strictObject({
    id: botInboxItemSchema.shape.id,
    kind: botInboxItemSchema.shape.kind,
    staleReason: botInboxItemSchema.shape.staleReason,
    title: botInboxItemSchema.shape.title,
    body: z.string().max(MOBILE_BOT_INBOX_BODY_MAX_LENGTH + 2),
    isBodyClipped: z.boolean(),
    options: botInboxItemSchema.shape.options,
    pullRequest: z
        .strictObject({
            url: z.string().max(512),
            repo: z.string().min(1).max(100),
            number: z.number().int().positive(),
        })
        .optional(),
    replies: z.array(mobileBotInboxReplySchema).max(MOBILE_BOT_INBOX_MAX_REPLIES),
    earlierReplyCount: z.number().int().nonnegative(),
    acknowledgedSequence: botInboxItemSchema.shape.acknowledgedSequence,
    updatedAt: z.number(),
});

export const mobileBotInboxListResultSchema = z.strictObject({
    items: z.array(mobileBotInboxItemSchema).max(MOBILE_BOT_INBOX_MAX_ITEMS),
    /**
     * Every open item, including any that did not fit this reply.
     */
    total: z.number().int().nonnegative().max(MAX_BOT_INBOX_OPEN_ITEMS),
    truncated: z.boolean(),
});

const mobileBotInboxReplyParametersSchema = botInboxMethods['bot.inbox.reply'].params;
const mobileBotInboxReplyResultSchema = z.strictObject({
    sequence: z.number().int().positive(),
});

export type MobileBotInboxItem = z.infer<typeof mobileBotInboxItemSchema>;
export type MobileBotInboxListResult = z.infer<typeof mobileBotInboxListResultSchema>;

const byteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

function projectItem(item: BotInboxItem): MobileBotInboxItem {
    const body = clipHead(item.body, MOBILE_BOT_INBOX_BODY_MAX_LENGTH);
    const replies = item.replies.slice(-MOBILE_BOT_INBOX_MAX_REPLIES);
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
            body: clipHead(reply.body, MOBILE_BOT_INBOX_REPLY_MAX_LENGTH).text,
            createdAt: reply.createdAt,
        })),
        earlierReplyCount: item.replies.length - replies.length,
        acknowledgedSequence: item.acknowledgedSequence,
        updatedAt: item.updatedAt,
    };
}

/**
 * The open items a phone can carry in one frame, questions first (see `orderBotInboxItems`), so a pull request is the
 * first thing dropped when the budget runs out. `truncated` tells the phone some open items are only on Desktop.
 */
export function projectBotInboxForMobile(inbox: BotInbox): MobileBotInboxListResult {
    const open = orderBotInboxItems(inbox.items.filter((item) => item.status === 'open'));
    const items: MobileBotInboxItem[] = [];
    let budget =
        MOBILE_BOT_INBOX_MAX_BYTES - byteLength({ items: [], total: open.length, truncated: true });
    for (const item of open) {
        if (items.length >= MOBILE_BOT_INBOX_MAX_ITEMS) break;
        const projected = projectItem(item);
        const cost = byteLength(projected) + 1;
        if (cost > budget) break;
        budget -= cost;
        items.push(projected);
    }
    return { items, total: open.length, truncated: items.length < open.length };
}

/**
 * The Bot Inbox from a paired device: read the open items and reply to one. Merge and Dismiss stay on Desktop.
 */
export const mobileBotInboxMethods = {
    'mobile.botInbox.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}).default({}),
        result: mobileBotInboxListResultSchema,
    },
    'mobile.botInbox.reply': {
        ...commandPolicy('server', 'write', ['terminals.steer']),
        params: mobileBotInboxReplyParametersSchema,
        result: mobileBotInboxReplyResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const mobileBotInboxInternalMethods = {
    'mobile.botInbox.replyInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileBotInboxReplyParametersSchema.extend({ principal: principalSchema }),
        result: mobileBotInboxReplyResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
