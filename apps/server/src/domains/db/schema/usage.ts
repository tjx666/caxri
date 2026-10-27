import type { UsagePullRequestState } from '@caxri/protocol';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';

/**
 * The Usage page's tables: the ledger of Agent Sessions Caxri hosted, the scan cache for transcripts found elsewhere,
 * and the pull request outcomes they produced.
 */

const pullRequestOutcomeStates = closedValues<UsagePullRequestState>()([
    'open',
    'merged',
    'closed',
    'missing',
]);

/**
 * Usage ledger: one row per Agent Session ever bound to a Terminal of a Caxri Session. `terminals.agent_session_id`
 * holds only the current binding and is overwritten by `/clear`, provider switches, and Terminal close, so this table
 * is the only durable record of which provider conversations Caxri itself hosted. Rows are appended by
 * `TerminalsModel.updateAgentSessionId` and the usage service's reconciliation pass, never updated by the Agent.
 *
 * `session_id`, `project_id`, and `terminal_id` intentionally carry no foreign key: tokens already spent stay spent
 * after Session, Project, or Terminal metadata is deleted, and the report labels such rows instead of dropping them.
 *
 * `usage_json` caches the parsed, content-free token aggregate (hourly buckets per model, active time, created pull
 * request URLs) so history survives a provider pruning its own transcripts. `source_fingerprint` is the size and mtime
 * of every transcript file that produced it; a mismatch triggers a rescan.
 */
export const agentSessionUsage = sqliteTable(
    'agent_session_usage',
    {
        provider: text('provider').notNull(),
        agentSessionId: text('agent_session_id').notNull(),
        sessionId: text('session_id').notNull(),
        projectId: text('project_id').notNull(),
        terminalId: text('terminal_id').notNull(),
        /**
         * Provider state root (`terminals.agent_cwd ?? terminals.cwd`) at the latest observed binding; locates the
         * transcript after the Terminal is gone.
         */
        cwd: text('cwd').notNull(),
        boundAt: integer('bound_at').notNull(),
        sourceFingerprint: text('source_fingerprint'),
        scannedAt: integer('scanned_at'),
        usageJson: text('usage_json'),
    },
    (table) => [
        primaryKey({ columns: [table.provider, table.agentSessionId] }),
        index('agent_session_usage_session').on(table.sessionId),
    ],
);

/**
 * Scan cache for Agent transcripts found on this machine outside the usage ledger: conversations the user ran in a
 * plain terminal or another app, read only when the Usage page asks for every Agent Session. One row per transcript
 * file, so a reverted Codex thread's continuation rollout (`<thread>_<rollout>`) keeps its own row; `agent_session_id`
 * is the provider conversation identity the ledger is keyed by, so a conversation later resumed in a Caxri Session is
 * counted once, from the ledger. Rows outlive their transcript for the same reason ledger rows do.
 */
export const externalAgentUsage = sqliteTable(
    'external_agent_usage',
    {
        provider: text('provider').notNull(),
        /**
         * Agent Session ID, or the Codex rollout ID for a reverted thread's continuation file.
         */
        transcriptId: text('transcript_id').notNull(),
        agentSessionId: text('agent_session_id').notNull(),
        path: text('path').notNull(),
        /**
         * Working directory the provider recorded for the conversation; attributes it to a Project. Null when the
         * transcript names none.
         */
        cwd: text('cwd'),
        sourceFingerprint: text('source_fingerprint').notNull(),
        scannedAt: integer('scanned_at').notNull(),
        usageJson: text('usage_json').notNull(),
    },
    (table) => [primaryKey({ columns: [table.provider, table.transcriptId] })],
);

/**
 * Last known GitHub outcome of a pull request an Agent created from a Caxri Session. Merged and closed rows are final
 * and never refetched; open rows are refreshed on a bounded schedule by the usage service. Keyed by the canonical
 * `https://github.com/<owner>/<repo>/pull/<number>` URL harvested from the transcript.
 */
export const pullRequestOutcomes = sqliteTable(
    'pull_request_outcomes',
    {
        url: text('url').primaryKey(),
        state: text('state').notNull(),
        title: text('title').notNull(),
        createdAt: integer('created_at'),
        mergedAt: integer('merged_at'),
        additions: integer('additions').notNull().default(0),
        deletions: integer('deletions').notNull().default(0),
        checkedAt: integer('checked_at').notNull(),
    },
    (table) => [
        check('pull_request_outcomes_state', isOneOf(table.state, pullRequestOutcomeStates)),
    ],
);
