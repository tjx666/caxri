import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import {
    projectStatusStateSchema,
    pullRequestMergeStateSchema,
} from '../domain/project-status-state.js';
import { sessionPullRequestStateSchema } from '../domain/session-pull-request.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bounds that keep one Commander from growing the Inbox without limit. Open items are what the owner still owes,
 * so a Commander that would exceed them is told to resolve some first rather than silently losing the oldest.
 */
export const MAX_COMMANDER_INBOX_OPEN_ITEMS = 200;
export const MAX_COMMANDER_INBOX_CLOSED_ITEMS = 50;
export const MAX_COMMANDER_INBOX_REPLIES = 50;
export const MAX_COMMANDER_INBOX_OPTIONS = 8;
export const MAX_COMMANDER_INBOX_TITLE_LENGTH = 200;
export const MAX_COMMANDER_INBOX_BODY_LENGTH = 16_384;
export const MAX_COMMANDER_INBOX_REPLY_LENGTH = 8_192;

/**
 * What the owner owes the Commander. `decision` covers every escalation the Commander's instructions list (a product or
 * scope choice, a table definition, a destructive or credential-bearing step, an ambiguous request); `hands` is a step
 * only the owner can physically do (a login, a device, a native prompt); `merge` is a pull request the Commander
 * verified and judged ready for the owner to merge.
 */
export const commanderInboxKindIds = ['decision', 'hands', 'merge'] as const;
export const commanderInboxKindSchema = z.enum(commanderInboxKindIds);

/**
 * Lifecycle only. Whether the owner replied, whether the Commander read the reply, and whether a pull request's
 * evidence is stale are separate fields, because any of them can hold while the item is still open.
 */
export const commanderInboxStatusIds = ['open', 'closed'] as const;
export const commanderInboxStatusSchema = z.enum(commanderInboxStatusIds);

/**
 * Why an item closed. `merged` and `pullRequestClosed` come from GitHub (the owner may have merged in the browser);
 * `resolved` is the Commander declaring the matter settled; `dismissed` is the owner declining to act.
 */
export const commanderInboxCloseReasonIds = [
    'merged',
    'pullRequestClosed',
    'resolved',
    'dismissed',
] as const;
export const commanderInboxCloseReasonSchema = z.enum(commanderInboxCloseReasonIds);

/**
 * Why a `merge` item's evidence no longer describes the pull request. A moved head means the Commander verified older
 * code, so the item stays open but cannot be merged until the Commander re-verifies and reports the new head.
 */
export const commanderInboxStaleReasonIds = ['headMoved'] as const;
export const commanderInboxStaleReasonSchema = z.enum(commanderInboxStaleReasonIds);

export const commanderInboxReplySourceIds = ['desktop', 'mobile'] as const;
export const commanderInboxReplySourceSchema = z.enum(commanderInboxReplySourceIds);

const gitShaSchema = z.string().regex(/^[\da-f]{40}$/u);

/**
 * A GitHub pull request page, the only form the Commander can name one in. The owner, repository, and number are parsed
 * from it on the Server rather than accepted separately, so they can never disagree with the link.
 */
export const commanderInboxPullRequestUrlSchema = z
    .string()
    .max(512)
    .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/u);

/**
 * Splits a validated pull request URL into its repository and number.
 */
export function parseCommanderInboxPullRequestUrl(url: string): {
    owner: string;
    repo: string;
    number: number;
} {
    const [owner, repo, , number] = new URL(commanderInboxPullRequestUrlSchema.parse(url)).pathname
        .slice(1)
        .split('/', 4);
    return { owner, repo, number: Number(number) };
}

export const commanderInboxPullRequestSchema = z.strictObject({
    url: commanderInboxPullRequestUrlSchema,
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    number: z.number().int().positive(),
    /**
     * The head commit the Commander verified. A merge from the Inbox is pinned to exactly this commit.
     */
    headSha: gitShaSchema,
});

/**
 * GitHub's current view of a `merge` item's pull request, read from the Server's shared pull-request record. Memory
 * only: it is refreshed on a schedule and absent until the first read succeeds, or when the last one failed.
 */
export const commanderInboxPullRequestLiveSchema = z.strictObject({
    title: z.string().max(1_000),
    lifecycle: sessionPullRequestStateSchema,
    checks: projectStatusStateSchema.optional(),
    mergeState: pullRequestMergeStateSchema.optional(),
    headSha: gitShaSchema.optional(),
    refreshedAt: z.number(),
});

export const commanderInboxReplySchema = z.strictObject({
    /**
     * 1-based, increasing per item. The Commander acknowledges the highest sequence it has read.
     */
    sequence: z.number().int().positive(),
    body: z.string().min(1).max(MAX_COMMANDER_INBOX_REPLY_LENGTH),
    source: commanderInboxReplySourceSchema,
    createdAt: z.number(),
});

export const commanderInboxItemSchema = z.strictObject({
    id: identifierSchema,
    kind: commanderInboxKindSchema,
    status: commanderInboxStatusSchema,
    closeReason: commanderInboxCloseReasonSchema.optional(),
    staleReason: commanderInboxStaleReasonSchema.optional(),
    title: z.string().min(1).max(MAX_COMMANDER_INBOX_TITLE_LENGTH),
    /**
     * Commander-authored Markdown. For a `merge` item it carries the Bug, Cause, Fix, Evidence, and Risk report.
     */
    body: z.string().max(MAX_COMMANDER_INBOX_BODY_LENGTH),
    /**
     * Choices the Commander offers for a decision. Free-text replies stay possible either way.
     */
    options: z
        .array(z.string().min(1).max(MAX_COMMANDER_INBOX_TITLE_LENGTH))
        .max(MAX_COMMANDER_INBOX_OPTIONS),
    sessionId: identifierSchema.optional(),
    delegationId: identifierSchema.optional(),
    pullRequest: commanderInboxPullRequestSchema.optional(),
    pullRequestLive: commanderInboxPullRequestLiveSchema.optional(),
    replies: z.array(commanderInboxReplySchema).max(MAX_COMMANDER_INBOX_REPLIES),
    /**
     * Highest reply sequence the Commander acknowledged reading; `0` before any.
     */
    acknowledgedSequence: z.number().int().nonnegative(),
    /**
     * Increments when the Commander files a new report for the item (or it closes), not on replies, acknowledgements,
     * or stale marks. The owner's merge names the revision they read, so a report the Commander replaced in the
     * meantime is never merged on the strength of the old one.
     */
    revision: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
    closedAt: z.number().optional(),
});

export const commanderInboxSchema = z.strictObject({
    generatedAt: z.number(),
    items: z
        .array(commanderInboxItemSchema)
        .max(MAX_COMMANDER_INBOX_OPEN_ITEMS + MAX_COMMANDER_INBOX_CLOSED_ITEMS),
});

export const commanderInboxAddSchema = z.strictObject({
    kind: commanderInboxKindSchema,
    /**
     * Deduplication key for `decision` and `hands`: reporting again with the same key updates the open item instead of
     * adding a second one. A `merge` item is always keyed by its pull request.
     */
    key: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(MAX_COMMANDER_INBOX_TITLE_LENGTH),
    body: z.string().max(MAX_COMMANDER_INBOX_BODY_LENGTH).default(''),
    options: z
        .array(z.string().min(1).max(MAX_COMMANDER_INBOX_TITLE_LENGTH))
        .max(MAX_COMMANDER_INBOX_OPTIONS)
        .default([]),
    sessionId: identifierSchema.optional(),
    delegationId: identifierSchema.optional(),
    pullRequest: z
        .strictObject({ url: commanderInboxPullRequestUrlSchema, headSha: gitShaSchema })
        .optional(),
});

const itemTargetSchema = z.strictObject({ id: identifierSchema });

export type CommanderInboxKind = z.infer<typeof commanderInboxKindSchema>;
export type CommanderInboxStatus = z.infer<typeof commanderInboxStatusSchema>;
export type CommanderInboxCloseReason = z.infer<typeof commanderInboxCloseReasonSchema>;
export type CommanderInboxStaleReason = z.infer<typeof commanderInboxStaleReasonSchema>;
export type CommanderInboxReplySource = z.infer<typeof commanderInboxReplySourceSchema>;
export type CommanderInboxPullRequest = z.infer<typeof commanderInboxPullRequestSchema>;
export type CommanderInboxPullRequestLive = z.infer<typeof commanderInboxPullRequestLiveSchema>;
export type CommanderInboxReply = z.infer<typeof commanderInboxReplySchema>;
export type CommanderInboxItem = z.infer<typeof commanderInboxItemSchema>;
export type CommanderInbox = z.infer<typeof commanderInboxSchema>;
export type CommanderInboxAddInput = z.infer<typeof commanderInboxAddSchema>;

/**
 * The Commander Inbox: what the Agent Commander explicitly raised for the owner to act on. The Commander adds, lists,
 * reads, resolves, and acknowledges through its `commander` capability; replying, dismissing, and merging require the
 * owner's `desktop` capability, so the Commander can never answer its own question or merge its own report. See
 * `docs/agent-commander.md#commander-inbox`.
 */
export const commanderInboxMethods = {
    'commander.inbox.list': {
        ...commandPolicy('server', 'read', ['commander']),
        params: z.strictObject({ includeClosed: z.boolean().optional() }).default({}),
        result: commanderInboxSchema,
    },
    'commander.inbox.show': {
        ...commandPolicy('server', 'read', ['commander']),
        params: itemTargetSchema,
        result: commanderInboxItemSchema,
    },
    /**
     * Adds an item, or updates the open item with the same kind and key. Updating a `merge` item with a new head clears
     * its stale mark, because the Commander has re-verified.
     */
    'commander.inbox.add': {
        ...commandPolicy('server', 'control', ['commander']),
        params: commanderInboxAddSchema,
        result: commanderInboxItemSchema,
    },
    'commander.inbox.resolve': {
        ...commandPolicy('server', 'control', ['commander']),
        params: itemTargetSchema,
        result: commanderInboxItemSchema,
    },
    /**
     * Records that the Commander read every reply up to `sequence`. Unacknowledged replies are announced again after a
     * Server or Commander restart.
     */
    'commander.inbox.ack': {
        ...commandPolicy('server', 'control', ['commander']),
        params: z.strictObject({
            id: identifierSchema,
            sequence: z.number().int().positive(),
        }),
        result: commanderInboxItemSchema,
    },
    'commander.inbox.reply': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: z.strictObject({
            id: identifierSchema,
            body: z.string().trim().min(1).max(MAX_COMMANDER_INBOX_REPLY_LENGTH),
        }),
        result: commanderInboxItemSchema,
    },
    'commander.inbox.dismiss': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: itemTargetSchema,
        result: commanderInboxItemSchema,
    },
    /**
     * Merges a `merge` item's pull request, pinned to the head the Commander verified. `revision` is the item revision
     * the owner read; a newer report, a moved head, or a closed item refuses with `CONFLICT`.
     */
    'commander.inbox.merge': {
        ...commandPolicy('server', 'write', ['desktop']),
        params: z.strictObject({
            id: identifierSchema,
            revision: z.number().int().positive(),
        }),
        result: z.strictObject({
            item: commanderInboxItemSchema,
            method: z.enum(['squash', 'merge', 'rebase']),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
