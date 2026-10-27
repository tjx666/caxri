import type { BenchmarkRunStatus } from '@caxri/protocol';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './schema-constraints';

/**
 * Benchmark runs. Kept beside `./schema` like Caxri Bot tables; `./full-schema` joins it for drizzle-kit, the drift
 * guard, and the connection.
 */

const benchmarkRunStatuses = closedValues<BenchmarkRunStatus>()([
    'running',
    'completed',
    'cancelled',
]);

/**
 * One Benchmark run and its Attempts as one validated `BenchmarkRun` document. An Attempt changes only at a few
 * transitions (started, finished, checked, judged), and every read wants the whole run, so a row per Attempt would add
 * joins without a query that needs them. Live progress (elapsed time, step count) stays in memory until a transition.
 * Deliberately no foreign key to `projects`: a run outlives the Project it cloned, since it keeps its own folders.
 */
export const benchmarkRuns = sqliteTable(
    'benchmark_runs',
    {
        id: text('id').primaryKey(),
        status: text('status').notNull(),
        createdAt: integer('created_at').notNull(),
        documentJson: text('document_json').notNull(),
    },
    (table) => [
        check('benchmark_run_status', isOneOf(table.status, benchmarkRunStatuses)),
        index('benchmark_runs_created').on(table.createdAt),
    ],
);
