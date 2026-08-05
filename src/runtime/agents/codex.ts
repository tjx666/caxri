import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { canonicalPath, type AgentSnapshotContext, type LocalAgentState } from './state';

interface SqliteColumn {
    name: string;
}

interface CodexThreadRow {
    id: string;
    title: string;
    tokens_used?: number;
}

async function findCodexDatabases(directories: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const directory of [...new Set(directories)]) {
        try {
            const names = await readdir(directory);
            paths.push(
                ...names
                    .filter((name) => /^state_\d+\.sqlite$/.test(name))
                    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
                    .map((name) => join(directory, name)),
            );
        } catch {
            /** Missing or unreadable state directories are normal capability misses. */
        }
    }
    return paths;
}

/** Queries only a capability-detected Codex thread index and never opens rollout transcripts. */
export async function readCodexState(
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
            const tokens = columns.has('tokens_used') ? ', tokens_used' : '';
            const archived = columns.has('archived') ? 'archived = 0 AND ' : '';
            const session = context.agentSessionId ? 'id = ? AND ' : '';
            const placeholders = requestedRoots.map(() => '?').join(', ');
            const row = database
                .prepare(
                    `SELECT id, title${tokens} FROM threads WHERE ${archived}${session}cwd IN (${placeholders}) ORDER BY ${updatedColumn} DESC LIMIT 1`,
                )
                .get(
                    ...(context.agentSessionId ? [context.agentSessionId] : []),
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
