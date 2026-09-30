import Database from 'better-sqlite3';

import type { AgentSnapshotContext, LocalAgentState } from '../../contract';
import { readCodexCurrentRolloutId } from './rollouts';
import type { SqliteColumn } from './state-databases';
import { findCodexStateDatabases } from './state-databases';

interface CodexTurnRow {
    turn_id: string;
    status: string;
}

export async function readCodexTurnState(
    context: Pick<AgentSnapshotContext, 'agentSessionId' | 'agentTurnId'>,
    stateDirectories: string[],
): Promise<Pick<LocalAgentState, 'activitySource' | 'activityTurnId' | 'status'> | undefined> {
    if (!context.agentSessionId) return undefined;
    const databasePaths = await findCodexStateDatabases(
        stateDirectories,
        /^thread_history_\d+\.sqlite$/,
    );
    if (databasePaths.length === 0) return undefined;
    const rolloutId = await readCodexCurrentRolloutId(context.agentSessionId, stateDirectories);
    /**
     * After a revert, turns started on the new rollout are keyed by its rollout ID, while the retained prefix stays
     * under the thread ID. Querying only the thread ID then finds no row for the running turn, so the probe reports
     * unknown and the hook turn eventually expires while Codex is still working.
     */
    const rolloutIds = rolloutId ? [rolloutId, context.agentSessionId] : [context.agentSessionId];
    const threadFilter =
        rolloutIds.length === 1
            ? 'thread_id = ?'
            : `thread_id IN (${rolloutIds.map(() => '?').join(', ')})`;
    for (const path of databasePaths) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(thread_turns)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (['thread_id', 'turn_id', 'status'].some((column) => !columns.has(column))) continue;
            const isExactTurn = context.agentTurnId !== undefined;
            /**
             * A validated hook supplies the exact turn and remains authoritative. Restored PTYs may not inherit the
             * current hook environment, though, so a bound thread also needs a persisted-state fallback: Codex writes
             * `inProgress` before rendering work and advances `rollout_ordinal` for every new turn. Older supported
             * stores predate that column; their insertion order is the only available recency signal.
             *
             * After a revert the current rollout ranks first: the revert can drop turns whose ordinals exceed the new
             * rollout's, and those abandoned rows must not outrank the turn the user is actually running.
             *
             * @see https://github.com/openai/codex/blob/5af85998/codex-rs/thread-store/src/local/thread_history.rs
             */
            const recency = columns.has('rollout_ordinal') ? 'rollout_ordinal DESC' : 'rowid DESC';
            const order = isExactTurn
                ? ''
                : rolloutId
                  ? ` ORDER BY thread_id = ? DESC, ${recency}`
                  : ` ORDER BY ${recency}`;
            const row = database
                .prepare(
                    `SELECT turn_id, status FROM thread_turns WHERE ${threadFilter}${isExactTurn ? ' AND turn_id = ?' : ''}${order} LIMIT 1`,
                )
                .get(
                    ...rolloutIds,
                    ...(isExactTurn ? [context.agentTurnId] : []),
                    ...(!isExactTurn && rolloutId ? [rolloutId] : []),
                ) as CodexTurnRow | undefined;
            const status =
                row?.status === 'inProgress'
                    ? 'running'
                    : row?.status === 'failed'
                      ? 'failed'
                      : row?.status === 'completed' || row?.status === 'interrupted'
                        ? 'completed'
                        : undefined;
            if (row && status)
                return {
                    activitySource: isExactTurn ? 'exactTurn' : 'latestTurn',
                    activityTurnId: row.turn_id,
                    status,
                };
        } catch {
            /**
             * Codex owns this private database schema; missing tables and schema drift degrade to unknown.
             */
        } finally {
            database?.close();
        }
    }
    return undefined;
}

export async function readCodexTurnStatus(
    context: Pick<AgentSnapshotContext, 'agentSessionId' | 'agentTurnId'>,
    stateDirectories: string[],
): Promise<LocalAgentState['status']> {
    return (await readCodexTurnState(context, stateDirectories))?.status;
}
