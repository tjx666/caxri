import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import {
    projectStatusStateSchema,
    pullRequestMergeStateSchema,
} from '../../domain/project-status-state.js';
import { sessionPullRequestStateSchema } from '../../domain/session-pull-request.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';

/**
 * Upper bounds that keep one Caxri Bot from growing the Inbox without limit. Open items are what the owner still owes,
 * so Caxri Bot is told, when it would exceed them, to resolve some first rather than silently losing the oldest.
 */
export const MAX_BOT_INBOX_OPEN_ITEMS = 200;
export const MAX_BOT_INBOX_CLOSED_ITEMS = 50;
export const MAX_BOT_INBOX_REPLIES = 50;
export const MAX_BOT_INBOX_OPTIONS = 8;
export const MAX_BOT_INBOX_TITLE_LENGTH = 200;
export const MAX_BOT_INBOX_BODY_LENGTH = 16_384;
export const MAX_BOT_INBOX_REPLY_LENGTH = 8_192;

/**
 * What the owner owes Caxri Bot. `decision` covers every escalation Caxri Bot's instructions list (a product or scope
 * choice, a table definition, a destructive or credential-bearing step, an ambiguous request); `hands` is a step only
 * the owner can physically do (a login, a device, a native prompt); `merge` is a pull request Caxri Bot verified and
 * judged ready for the owner to merge.
 */
export const botInboxKindIds = ['decision', 'hands', 'merge'] as const;
export const botInboxKindSchema = z.enum(botInboxKindIds);

/**
 * Lifecycle only. Whether the owner replied, whether Caxri Bot read the reply, and whether a pull request's evidence is
 * stale are separate fields, because any of them can hold while the item is still open.
 */
export const botInboxStatusIds = ['open', 'closed'] as const;
export const botInboxStatusSchema = z.enum(botInboxStatusIds);

/**
 * Why an item closed. `merged` and `pullRequestClosed` come from GitHub (the owner may have merged in the browser);
 * `resolved` is Caxri Bot declaring the matter settled; `dismissed` is the owner declining to act.
 */
export const botInboxCloseReasonIds = [
    'merged',
    'pullRequestClosed',
    'resolved',
    'dismissed',
] as const;
export const botInboxCloseReasonSchema = z.enum(botInboxCloseReasonIds);

/**
 * Why a `merge` item's evidence no longer describes the pull request. A moved head means Caxri Bot verified older code,
 * so the item stays open but cannot be merged until Caxri Bot re-verifies and reports the new head.
 */
export const botInboxStaleReasonIds = ['headMoved'] as const;
export const botInboxStaleReasonSchema = z.enum(botInboxStaleReasonIds);

export const botInboxReplySourceIds = ['desktop', 'mobile'] as const;
export const botInboxReplySourceSchema = z.enum(botInboxReplySourceIds);

const gitShaSchema = z.string().regex(/^[\da-f]{40}$/u);

/**
 * A GitHub pull request page, the only form Caxri Bot can name one in. The owner, repository, and number are parsed
 * from it on the Server rather than accepted separately, so they can never disagree with the link.
 */
export const botInboxPullRequestUrlSchema = z
    .string()
    .max(512)
    .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/u);

/**
 * Splits a validated pull request URL into its repository and number.
 */
export function parseBotInboxPullRequestUrl(url: string): {
    owner: string;
    repo: string;
    number: number;
} {
    const [owner, repo, , number] = new URL(botInboxPullRequestUrlSchema.parse(url)).pathname
        .slice(1)
        .split('/', 4);
    return { owner, repo, number: Number(number) };
}

export const botInboxPullRequestSchema = z.strictObject({
    url: botInboxPullRequestUrlSchema,
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    number: z.number().int().positive(),
    /**
     * The head commit Caxri Bot verified. A merge from the Inbox is pinned to exactly this commit.
     */
    headSha: gitShaSchema,
});

/**
 * GitHub's current view of a `merge` item's pull request, read from the Server's shared pull-request record. Memory
 * only: it is refreshed on a schedule and absent until the first read succeeds, or when the last one failed.
 */
export const botInboxPullRequestLiveSchema = z.strictObject({
    title: z.string().max(1_000),
    lifecycle: sessionPullRequestStateSchema,
    checks: projectStatusStateSchema.optional(),
    mergeState: pullRequestMergeStateSchema.optional(),
    headSha: gitShaSchema.optional(),
    refreshedAt: z.number(),
});

export const botInboxReplySchema = z.strictObject({
    /**
     * 1-based, increasing per item. Caxri Bot acknowledges the highest sequence it has read.
     */
    sequence: z.number().int().positive(),
    body: z.string().min(1).max(MAX_BOT_INBOX_REPLY_LENGTH),
    source: botInboxReplySourceSchema,
    createdAt: z.number(),
});

export const botInboxItemSchema = z.strictObject({
    id: identifierSchema,
    kind: botInboxKindSchema,
    status: botInboxStatusSchema,
    closeReason: botInboxCloseReasonSchema.optional(),
    staleReason: botInboxStaleReasonSchema.optional(),
    title: z.string().min(1).max(MAX_BOT_INBOX_TITLE_LENGTH),
    /**
     * Caxri Bot-authored Markdown. For a `merge` item it carries the Bug, Cause, Fix, Evidence, and Risk report.
     */
    body: z.string().max(MAX_BOT_INBOX_BODY_LENGTH),
    /**
     * Choices Caxri Bot offers for a decision. Free-text replies stay possible either way.
     */
    options: z.array(z.string().min(1).max(MAX_BOT_INBOX_TITLE_LENGTH)).max(MAX_BOT_INBOX_OPTIONS),
    sessionId: identifierSchema.optional(),
    delegationId: identifierSchema.optional(),
    pullRequest: botInboxPullRequestSchema.optional(),
    pullRequestLive: botInboxPullRequestLiveSchema.optional(),
    replies: z.array(botInboxReplySchema).max(MAX_BOT_INBOX_REPLIES),
    /**
     * Highest reply sequence Caxri Bot acknowledged reading; `0` before any.
     */
    acknowledgedSequence: z.number().int().nonnegative(),
    /**
     * Increments when Caxri Bot files a new report for the item (or it closes), not on replies, acknowledgements, or
     * stale marks. The owner's merge names the revision they read, so a report Caxri Bot replaced in the meantime is
     * never merged on the strength of the old one.
     */
    revision: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
    closedAt: z.number().optional(),
});

export const botInboxSchema = z.strictObject({
    generatedAt: z.number(),
    items: z.array(botInboxItemSchema).max(MAX_BOT_INBOX_OPEN_ITEMS + MAX_BOT_INBOX_CLOSED_ITEMS),
});

export const botInboxAddSchema = z.strictObject({
    kind: botInboxKindSchema,
    /**
     * Deduplication key for `decision` and `hands`: reporting again with the same key updates the open item instead of
     * adding a second one. A `merge` item is always keyed by its pull request.
     */
    key: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(MAX_BOT_INBOX_TITLE_LENGTH),
    body: z.string().max(MAX_BOT_INBOX_BODY_LENGTH).default(''),
    options: z
        .array(z.string().min(1).max(MAX_BOT_INBOX_TITLE_LENGTH))
        .max(MAX_BOT_INBOX_OPTIONS)
        .default([]),
    sessionId: identifierSchema.optional(),
    delegationId: identifierSchema.optional(),
    pullRequest: z
        .strictObject({ url: botInboxPullRequestUrlSchema, headSha: gitShaSchema })
        .optional(),
});

const itemTargetSchema = z.strictObject({ id: identifierSchema });

export type BotInboxKind = z.infer<typeof botInboxKindSchema>;
export type BotInboxStatus = z.infer<typeof botInboxStatusSchema>;
export type BotInboxCloseReason = z.infer<typeof botInboxCloseReasonSchema>;
export type BotInboxStaleReason = z.infer<typeof botInboxStaleReasonSchema>;
export type BotInboxReplySource = z.infer<typeof botInboxReplySourceSchema>;
export type BotInboxPullRequest = z.infer<typeof botInboxPullRequestSchema>;
export type BotInboxPullRequestLive = z.infer<typeof botInboxPullRequestLiveSchema>;
export type BotInboxReply = z.infer<typeof botInboxReplySchema>;
export type BotInboxItem = z.infer<typeof botInboxItemSchema>;
export type BotInbox = z.infer<typeof botInboxSchema>;
export type BotInboxAddInput = z.infer<typeof botInboxAddSchema>;

/**
 * The Bot Inbox: what Caxri Bot explicitly raised for the owner to act on. Caxri Bot adds, lists, reads, resolves, and
 * acknowledges through its `bot` capability; replying, dismissing, and merging require the owner's `desktop`
 * capability, so Caxri Bot can never answer its own question or merge its own report. See
 * `docs/caxri-bot.md#bot-inbox`.
 */
export const botInboxMethods = {
    'bot.inbox.list': {
        ...commandPolicy('server', 'read', ['bot']),
        params: z.strictObject({ includeClosed: z.boolean().optional() }).default({}),
        result: botInboxSchema,
    },
    'bot.inbox.show': {
        ...commandPolicy('server', 'read', ['bot']),
        params: itemTargetSchema,
        result: botInboxItemSchema,
    },
    /**
     * Adds an item, or updates the open item with the same kind and key. Updating a `merge` item with a new head clears
     * its stale mark, because Caxri Bot has re-verified.
     */
    'bot.inbox.add': {
        ...commandPolicy('server', 'control', ['bot']),
        params: botInboxAddSchema,
        result: botInboxItemSchema,
    },
    'bot.inbox.resolve': {
        ...commandPolicy('server', 'control', ['bot']),
        params: itemTargetSchema,
        result: botInboxItemSchema,
    },
    /**
     * Records that Caxri Bot read every reply up to `sequence`. Unacknowledged replies are announced again after a
     * Server or Caxri Bot restart.
     */
    'bot.inbox.ack': {
        ...commandPolicy('server', 'control', ['bot']),
        params: z.strictObject({
            id: identifierSchema,
            sequence: z.number().int().positive(),
        }),
        result: botInboxItemSchema,
    },
    'bot.inbox.reply': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: z.strictObject({
            id: identifierSchema,
            body: z.string().trim().min(1).max(MAX_BOT_INBOX_REPLY_LENGTH),
        }),
        result: botInboxItemSchema,
    },
    'bot.inbox.dismiss': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: itemTargetSchema,
        result: botInboxItemSchema,
    },
    /**
     * Merges a `merge` item's pull request, pinned to the head Caxri Bot verified. `revision` is the item revision the
     * owner read; a newer report, a moved head, or a closed item refuses with `CONFLICT`.
     */
    'bot.inbox.merge': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: z.strictObject({
            id: identifierSchema,
            revision: z.number().int().positive(),
        }),
        result: z.strictObject({
            item: botInboxItemSchema,
            method: z.enum(['squash', 'merge', 'rebase']),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
