import Database from 'better-sqlite3';

import type { AgentSnapshotContext, LocalAgentState } from '../../contract';
import { canonicalPath } from '../../contract';
import type { SqliteColumn } from './state-databases';
import { findCodexStateDatabases } from './state-databases';
import { readCodexTurnState } from './turn-state';

interface CodexThreadRow {
    id: string;
    session_is_subagent?: number | null;
    title?: string;
    tokens_used?: number;
}

const CODEX_PROVISIONAL_TITLE_CHARACTERS = 36;
const CODEX_SQLITE_WHITESPACE =
    'char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)';

/**
 * Queries only a capability-detected Codex thread index and never opens rollout transcripts.
 */
export async function readCodexState(
    context: AgentSnapshotContext,
    stateDirectories: string[],
): Promise<LocalAgentState | undefined> {
    const requestedRoots = [...new Set([context.rootPath, await canonicalPath(context.rootPath)])];
    const databasePaths = await findCodexStateDatabases(stateDirectories);
    let selectedRow: CodexThreadRow | undefined;
    for (const path of databasePaths) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(threads)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (['id', 'cwd'].some((column) => !columns.has(column))) continue;
            const spawnEdgeColumns = new Set(
                (
                    database
                        .prepare('PRAGMA table_info(thread_spawn_edges)')
                        .all() as SqliteColumn[]
                ).map((column) => column.name),
            );
            const sessionIsSubagentExpression = spawnEdgeColumns.has('child_thread_id')
                ? 'EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = selected.id)'
                : 'NULL';
            const updatedColumn = columns.has('updated_at_ms')
                ? 'updated_at_ms'
                : columns.has('updated_at')
                  ? 'updated_at'
                  : 'rowid';
            const timestampExpression = columns.has('created_at_ms')
                ? columns.has('created_at')
                    ? 'COALESCE(created_at_ms, created_at * 1000)'
                    : 'created_at_ms'
                : columns.has('created_at')
                  ? 'created_at * 1000'
                  : columns.has('updated_at_ms')
                    ? 'updated_at_ms'
                    : columns.has('updated_at')
                      ? 'updated_at * 1000'
                      : undefined;
            /**
             * `threads.title` is Codex's raw first prompt. The recursive CTE reproduces Codex's whitespace
             * normalization inside SQLite and returns NULL when `name` is still the provisional first-prompt prefix.
             * The raw prompt therefore never crosses into Server Core, where a projected title could reach a native
             * notification or the lock screen. Codex persists no provenance for the two writes, so a generated title
             * identical to the provisional prefix remains suppressed: privacy takes precedence over that ambiguous
             * display case.
             *
             * @see https://github.com/openai/codex/blob/09f4c4506874e75e25b967d51844cb699086e124/codex-rs/tui/src/app/thread_routing.rs#L1828-L1880
             */
            const titleExpression =
                columns.has('name') && columns.has('title')
                    ? `NULLIF(TRIM(name, ${CODEX_SQLITE_WHITESPACE}), '')`
                    : 'NULL';
            const firstPromptExpression = columns.has('title') ? 'title' : 'NULL';
            const tokens = columns.has('tokens_used') ? ', tokens_used' : '';
            const archived = columns.has('archived') ? 'archived = 0' : '';
            const session = context.agentSessionId ? 'id = ?' : '';
            const excludedSessionIds = context.agentSessionId
                ? []
                : [...new Set(context.excludedAgentSessionIds)].filter(Boolean);
            if (!timestampExpression && !context.agentSessionId && context.startedAt) continue;
            const excluded =
                excludedSessionIds.length > 0
                    ? `id NOT IN (${excludedSessionIds.map(() => '?').join(', ')})`
                    : '';
            const started =
                timestampExpression && !context.agentSessionId && context.startedAt
                    ? `${timestampExpression} >= ?`
                    : '';
            const order = started ? `${timestampExpression} ASC` : `${updatedColumn} DESC`;
            /**
             * An exact hook or persisted resume binding remains valid when the Agent moves into a linked worktree. The
             * opaque thread id is the authoritative selector in that case; cwd filtering is only for heuristic
             * discovery of an unbound Terminal.
             */
            const roots = context.agentSessionId
                ? ''
                : `cwd IN (${requestedRoots.map(() => '?').join(', ')})`;
            const where = [archived, session, excluded, started, roots]
                .filter((clause) => clause.length > 0)
                .join(' AND ');
            const row = database
                .prepare(
                    `WITH RECURSIVE
                        selected AS (
                            SELECT id, ${titleExpression} AS candidate_title, ${firstPromptExpression} AS first_prompt${tokens}
                            FROM threads
                            WHERE ${where}
                            ORDER BY ${order}
                            LIMIT 1
                        ),
                        normalized_prompt(remaining, normalized, separator_pending) AS (
                            SELECT ltrim(COALESCE(first_prompt, ''), ${CODEX_SQLITE_WHITESPACE}), '', 0
                            FROM selected
                            UNION ALL
                            SELECT
                                CASE
                                    WHEN instr(${CODEX_SQLITE_WHITESPACE}, substr(remaining, 1, 1)) > 0
                                        THEN ltrim(remaining, ${CODEX_SQLITE_WHITESPACE})
                                    ELSE substr(remaining, 2)
                                END,
                                CASE
                                    WHEN instr(${CODEX_SQLITE_WHITESPACE}, substr(remaining, 1, 1)) > 0
                                        THEN normalized
                                    ELSE normalized || CASE
                                        WHEN separator_pending = 1 AND normalized <> '' THEN ' '
                                        ELSE ''
                                    END || substr(remaining, 1, 1)
                                END,
                                CASE
                                    WHEN instr(${CODEX_SQLITE_WHITESPACE}, substr(remaining, 1, 1)) > 0 THEN 1
                                    ELSE 0
                                END
                            FROM normalized_prompt
                            WHERE remaining <> '' AND length(normalized) < ${CODEX_PROVISIONAL_TITLE_CHARACTERS}
                        )
                    SELECT id,
                        CASE
                            WHEN candidate_title = (
                                SELECT trim(
                                    substr(normalized, 1, ${CODEX_PROVISIONAL_TITLE_CHARACTERS}),
                                    ${CODEX_SQLITE_WHITESPACE}
                                )
                                FROM normalized_prompt
                                ORDER BY length(normalized) DESC, length(remaining) ASC
                                LIMIT 1
                            ) THEN NULL
                            ELSE candidate_title
                        END AS title,
                        ${sessionIsSubagentExpression} AS session_is_subagent${tokens}
                    FROM selected`,
                )
                .get(
                    ...(context.agentSessionId ? [context.agentSessionId] : []),
                    ...excludedSessionIds,
                    ...(started ? [context.startedAt] : []),
                    ...(context.agentSessionId ? [] : requestedRoots),
                ) as CodexThreadRow | undefined;
            if (!row) continue;
            selectedRow = row;
            break;
        } catch {
            /**
             * Private schema drift must degrade to unknown instead of affecting the Server.
             */
        } finally {
            database?.close();
        }
    }
    if (!selectedRow) return undefined;
    const turnState = await readCodexTurnState(context, stateDirectories);
    /**
     * No `titleSource`: Codex publishes no provenance for a thread name, so this provider cannot tell an upstream
     * AI-generated title from one the user typed at the Codex CLI (issue #671). Verified against codex-cli 0.154.0:
     * `threads` carries `title` (the raw first prompt) and `name` (the displayed title) and no column recording which
     * writer set `name`; the rollout stream's `session_meta` has no title field, and its only event payload types are
     * `item_completed`, `task_complete`, `task_started`, `thread_goal_updated`, `thread_settings_applied`,
     * `token_count`, and `turn_aborted`: none of them a rename. Both writers go through the same app-server
     * `thread/name/set` this provider itself calls for `renameCodexSession`.
     *
     * An unknown title source does not grant Caxri authority to overwrite the native name. The Session naming service
     * only generates when this provider reports no name (including the filtered provisional first-prompt prefix). It
     * keeps a pre-existing name under automatic ownership so later Codex renames still appear in Caxri. This also
     * preserves some generic Codex-generated names; distinguishing those from typed names requires upstream
     * provenance.
     */
    return {
        ...turnState,
        sessionId: selectedRow.id,
        sessionIsSubagent:
            selectedRow.session_is_subagent === null ||
            selectedRow.session_is_subagent === undefined
                ? undefined
                : selectedRow.session_is_subagent === 1,
        title: selectedRow.title?.trim(),
        usage:
            typeof selectedRow.tokens_used === 'number' && selectedRow.tokens_used > 0
                ? [{ label: 'Tokens', value: selectedRow.tokens_used.toLocaleString('en-US') }]
                : undefined,
    };
}
