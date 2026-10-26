import type { ClaudeWindowOutcome } from '@caxri/protocol';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './schema-constraints';

/**
 * The Claude 5-hour window keeper's per-account settings and schedule. Kept beside `./schema` like the Benchmark
 * tables; `./full-schema` joins it for drizzle-kit, the drift guard, and the connection.
 */

const outcomes = closedValues<ClaudeWindowOutcome>()([
    'natural_window_started',
    'trigger_confirmed',
    'trigger_unverified',
    'trigger_failed',
    'renewal_skipped',
    'weekly_limit',
    'auth_unsupported',
    'missed_while_asleep',
]);

/**
 * One row per Claude account, keyed by the SHA-256 of its organization and email: the email and organization themselves
 * are never stored. `keep_rolling` is null until the user chooses, so the plan default (on for Pro) applies and a later
 * plan change can move it; an explicit choice is kept. `processed_through` is the planned time (an anchor or a reset)
 * of the newest window the keeper handled, written before any request is sent, which makes every check idempotent
 * across restarts and repeated background runs.
 */
export const claudeWindowSchedules = sqliteTable(
    'claude_window_schedules',
    {
        accountHash: text('account_hash').primaryKey(),
        planType: text('plan_type'),
        keepRolling: integer('keep_rolling', { mode: 'boolean' }),
        firstWorkdayResetMinutes: integer('first_workday_reset_minutes'),
        processedThrough: integer('processed_through'),
        observedResetAt: integer('observed_reset_at'),
        /**
         * The reset of the window the keeper's own request started, so the status can say `confirmed`.
         */
        triggeredResetAt: integer('triggered_reset_at'),
        lastOutcome: text('last_outcome'),
        lastOutcomeAt: integer('last_outcome_at'),
        missedPlannedAt: integer('missed_planned_at'),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [check('claude_window_schedules_outcome', isOneOf(table.lastOutcome, outcomes))],
);
