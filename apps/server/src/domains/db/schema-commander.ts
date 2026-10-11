import type {
    CommanderInboxCloseReason,
    CommanderInboxKind,
    CommanderInboxReplySource,
    CommanderInboxStaleReason,
    CommanderInboxStatus,
    CommanderTaskStatus,
} from '@caxri/protocol';
import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { projects, sessions } from './schema';
import { closedValues, isOneOf } from './schema-constraints';

/**
 * Agent Commander tables. Kept beside `./schema` rather than in it so the core schema stays one reviewable file;
 * `./full-schema` joins both for drizzle-kit, the drift guard, and the connection.
 */

const commanderTaskStatuses = closedValues<CommanderTaskStatus>()([
    'pending',
    'dispatched',
    'waiting_user',
    'done',
    'dropped',
]);
/**
 * Owned by `CommanderPendingNoticesModel`; the notice kinds and statuses are Server-internal, with no protocol union.
 */
const commanderNoticeKinds = ['delegation', 'interrupted_turn'] as const;
const commanderNoticeStatuses = ['completed', 'failed', 'needsInput'] as const;

/**
 * The Agent Commander's durable task ledger (see `docs/agent-commander.md`). Replaces the free-form `ledger.md` the
 * Commander used to keep by hand, so its open work survives restarts and context compaction and is visible on the
 * board. `project_id` and `session_id` null out when their row is deleted (metadata only); `delegation_id` is the root
 * delegation and, like every delegation ID projection, carries no foreign key so a task outlives its receipt.
 */
export const commanderTasks = sqliteTable(
    'commander_tasks',
    {
        id: text('id').primaryKey(),
        title: text('title').notNull(),
        status: text('status').notNull(),
        projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
        sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
        delegationId: text('delegation_id'),
        note: text('note'),
        pullRequestUrl: text('pull_request_url'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
        index('commander_tasks_status').on(table.status),
        uniqueIndex('commander_tasks_delegation').on(table.delegationId),
        check('commander_tasks_status', isOneOf(table.status, commanderTaskStatuses)),
    ],
);

/**
 * Notices waiting to be typed into the Commander Terminal, so a Server restart no longer discards them. A row is
 * deleted once its notice is consumed: before a live write (at most once) or after a launch prompt carried it. `key`
 * deduplicates: `delegation:<id>` keeps only the newest pending transition per delegation, and `interrupted_turn` marks
 * a Commander turn that started but has not finished. No foreign keys: a notice about a deleted Session still tells the
 * Commander its task ended.
 */
export const commanderPendingNotices = sqliteTable(
    'commander_pending_notices',
    {
        key: text('key').primaryKey(),
        kind: text('kind').notNull(),
        delegationId: text('delegation_id'),
        sessionId: text('session_id'),
        status: text('status'),
        revision: integer('revision'),
        queuedAt: integer('queued_at').notNull(),
    },
    (table) => [
        check('commander_pending_notices_kind', isOneOf(table.kind, commanderNoticeKinds)),
        check('commander_pending_notices_status', isOneOf(table.status, commanderNoticeStatuses)),
    ],
);

const commanderInboxKinds = closedValues<CommanderInboxKind>()(['decision', 'hands', 'merge']);
const commanderInboxStatuses = closedValues<CommanderInboxStatus>()(['open', 'closed']);
const commanderInboxCloseReasons = closedValues<CommanderInboxCloseReason>()([
    'merged',
    'pullRequestClosed',
    'resolved',
    'dismissed',
]);
const commanderInboxStaleReasons = closedValues<CommanderInboxStaleReason>()(['headMoved']);
const commanderInboxReplySources = closedValues<CommanderInboxReplySource>()(['desktop', 'mobile']);

/**
 * What the Agent Commander raised for the owner to act on (see `docs/agent-commander.md#commander-inbox`). `title`,
 * `body`, and `options_json` are Commander-authored and `commander_inbox_replies.body` is the owner's text: both are
 * private domain data, never logged, journaled, or included in diagnostics.
 *
 * `session_id` and `delegation_id` deliberately carry no foreign key: an item stays the owner's to act on after the
 * Session that produced it is archived or deleted, and readers treat a missing Session as context that is gone, not as
 * a reason to drop the item.
 *
 * `dedup_key` is unique among open items only, so a key can be reused once its item closes. A `merge` item's key is its
 * pull request URL.
 */
export const commanderInboxItems = sqliteTable(
    'commander_inbox_items',
    {
        id: text('id').primaryKey(),
        kind: text('kind').notNull(),
        dedupKey: text('dedup_key'),
        status: text('status').notNull(),
        closeReason: text('close_reason'),
        staleReason: text('stale_reason'),
        title: text('title').notNull(),
        body: text('body').notNull(),
        optionsJson: text('options_json').notNull().default('[]'),
        sessionId: text('session_id'),
        delegationId: text('delegation_id'),
        pullRequestUrl: text('pull_request_url'),
        pullRequestHeadSha: text('pull_request_head_sha'),
        acknowledgedSequence: integer('acknowledged_sequence').notNull().default(0),
        revision: integer('revision').notNull().default(1),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
        closedAt: integer('closed_at'),
    },
    (table) => [
        uniqueIndex('commander_inbox_open_key')
            .on(table.kind, table.dedupKey)
            .where(sql`${table.status} = 'open'`),
        index('commander_inbox_status_updated').on(table.status, table.updatedAt),
        check('commander_inbox_kind', isOneOf(table.kind, commanderInboxKinds)),
        check('commander_inbox_status', isOneOf(table.status, commanderInboxStatuses)),
        check(
            'commander_inbox_close_reason',
            isOneOf(table.closeReason, commanderInboxCloseReasons),
        ),
        check(
            'commander_inbox_stale_reason',
            isOneOf(table.staleReason, commanderInboxStaleReasons),
        ),
    ],
);

/**
 * The owner's replies to one Inbox item, in order. Deleting an item deletes its replies.
 */
export const commanderInboxReplies = sqliteTable(
    'commander_inbox_replies',
    {
        itemId: text('item_id')
            .notNull()
            .references(() => commanderInboxItems.id, { onDelete: 'cascade' }),
        sequence: integer('sequence').notNull(),
        body: text('body').notNull(),
        source: text('source').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.itemId, table.sequence] }),
        check('commander_inbox_reply_source', isOneOf(table.source, commanderInboxReplySources)),
    ],
);
