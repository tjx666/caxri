import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { mapWithConcurrency } from '../../../../shared/node/concurrency';
import {
    canonicalPath,
    type AgentEnvironment,
    type AgentProviderDescriptor,
    type AgentSnapshotContext,
    type LocalAgentState,
} from '../../contract';

interface SqliteColumn {
    name: string;
}

interface CodexThreadRow {
    id: string;
    title: string;
    tokens_used?: number;
}

async function findCodexDatabases(directories: string[]): Promise<string[]> {
    const groups = await mapWithConcurrency([...new Set(directories)], 4, async (directory) => {
        try {
            const names = await readdir(directory);
            return names
                .filter((name) => /^state_\d+\.sqlite$/.test(name))
                .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
                .map((name) => join(directory, name));
        } catch {
            /** Missing or unreadable state directories are normal capability misses. */
            return [];
        }
    });
    return groups.flat();
}

/** Queries only a capability-detected Codex thread index and never opens rollout transcripts. */
async function readCodexState(
    context: AgentSnapshotContext,
    stateDirectories: string[],
): Promise<LocalAgentState | undefined> {
    const requestedRoots = [...new Set([context.rootPath, await canonicalPath(context.rootPath)])];
    for (const path of await findCodexDatabases(stateDirectories)) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(threads)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (!['id', 'cwd', 'title'].every((column) => columns.has(column))) continue;
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
            const titleExpression = columns.has('name')
                ? "COALESCE(NULLIF(TRIM(name), ''), title)"
                : 'title';
            const tokens = columns.has('tokens_used') ? ', tokens_used' : '';
            const archived = columns.has('archived') ? 'archived = 0 AND ' : '';
            const session = context.agentSessionId ? 'id = ? AND ' : '';
            const excludedSessionIds = context.agentSessionId
                ? []
                : [...new Set(context.excludedAgentSessionIds ?? [])].filter(Boolean);
            const excluded =
                excludedSessionIds.length > 0
                    ? `id NOT IN (${excludedSessionIds.map(() => '?').join(', ')}) AND `
                    : '';
            if (!context.agentSessionId && context.startedAt && !timestampExpression) continue;
            const started =
                !context.agentSessionId && context.startedAt && timestampExpression
                    ? `${timestampExpression} >= ? AND `
                    : '';
            const order = started ? `${timestampExpression} ASC` : `${updatedColumn} DESC`;
            const placeholders = requestedRoots.map(() => '?').join(', ');
            const row = database
                .prepare(
                    `SELECT id, ${titleExpression} AS title${tokens} FROM threads WHERE ${archived}${session}${excluded}${started}cwd IN (${placeholders}) ORDER BY ${order} LIMIT 1`,
                )
                .get(
                    ...(context.agentSessionId ? [context.agentSessionId] : []),
                    ...excludedSessionIds,
                    ...(started ? [context.startedAt] : []),
                    ...requestedRoots,
                ) as CodexThreadRow | undefined;
            if (!row) continue;
            return {
                sessionId: row.id,
                title: row.title.trim() || undefined,
                usage:
                    typeof row.tokens_used === 'number' && row.tokens_used > 0
                        ? [{ label: 'Tokens', value: row.tokens_used.toLocaleString('en-US') }]
                        : undefined,
            };
        } catch {
            /** Private schema drift must degrade to unknown instead of affecting the Runtime. */
        } finally {
            database?.close();
        }
    }
    return undefined;
}

/**
 * Resolves the ordered set of directories Codex may keep its thread index SQLite databases in, from
 * generic environment inputs. `CODEX_SQLITE_HOME` takes priority when set, followed by Codex's own
 * `sqlite` subdirectory and its home directory, mirroring Codex's own resolution order.
 */
function resolveCodexStateDirectories(environment: AgentEnvironment): string[] {
    const codexHome = environment.variables.CODEX_HOME || join(environment.homeDirectory, '.codex');
    const sqliteHome = environment.variables.CODEX_SQLITE_HOME;
    return [...(sqliteHome ? [resolve(sqliteHome)] : []), join(codexHome, 'sqlite'), codexHome];
}

export const codexProvider: AgentProviderDescriptor = {
    id: 'codex',
    readState: (context, environment) =>
        readCodexState(context, resolveCodexStateDirectories(environment)),
};
