import type { CommanderTaskStatus } from '@caxri/protocol';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
