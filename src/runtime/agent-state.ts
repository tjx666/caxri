import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type { AgentActivityState, ProcessState } from '../shared/types';

export interface AgentSnapshotContext {
    /** Keeps repeated probes bound to the Agent session already correlated with this Terminal. */
    agentSessionId?: string;
    processState?: ProcessState;
    rootPath: string;
}

export interface LocalAgentState {
    sessionId?: string;
    status?: AgentActivityState;
    title?: string;
    usage?: Array<{ label: string; value: string }>;
}

export interface AgentStateLocations {
    claudeConfigDirectory: string;
    codexStateDirectories: string[];
}

interface ClaudeSessionMetadata {
    cwd?: unknown;
    name?: unknown;
    sessionId?: unknown;
    status?: unknown;
    updatedAt?: unknown;
}

interface SqliteColumn {
    name: string;
}

interface CodexThreadRow {
    id: string;
    title: string;
    tokens_used?: number;
}

export function defaultAgentStateLocations(
    environment: NodeJS.ProcessEnv = process.env,
): AgentStateLocations {
    const home = homedir();
    const codexHome = environment.CODEX_HOME || join(home, '.codex');
    const sqliteHome = environment.CODEX_SQLITE_HOME;
    return {
        claudeConfigDirectory: environment.CLAUDE_CONFIG_DIR || join(home, '.claude'),
        codexStateDirectories: [
            ...(sqliteHome ? [resolve(sqliteHome)] : []),
            join(codexHome, 'sqlite'),
            codexHome,
        ],
    };
}

export function processStateToAgentActivity(state?: ProcessState): AgentActivityState {
    if (state === 'running' || state === 'starting') return 'running';
    if (state === 'failed' || state === 'dead') return 'failed';
    if (state === 'stopped') return 'completed';
    return 'unknown';
}

async function canonicalPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

function timestamp(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value) || 0;
    return 0;
}

function claudeStatus(value: unknown): AgentActivityState | undefined {
    if (value === 'busy') return 'running';
    if (value === 'idle') return 'waiting';
    if (value === 'completed' || value === 'failed') return value;
    return undefined;
}

/** Reads only Claude Code's compact live-session metadata, never project transcripts. */
export async function readClaudeState(
    context: AgentSnapshotContext,
    configDirectory: string,
): Promise<LocalAgentState | undefined> {
    const directory = join(configDirectory, 'sessions');
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .slice(0, 512);
    } catch {
        return undefined;
    }
    const requestedRoot = await canonicalPath(context.rootPath);
    const matches = await Promise.all(
        names.map(async (name) => {
            try {
                const source = await readFile(join(directory, name), 'utf8');
                if (source.length > 128 * 1024) return undefined;
                const metadata = JSON.parse(source) as ClaudeSessionMetadata;
                if (typeof metadata.cwd !== 'string') return undefined;
                if ((await canonicalPath(metadata.cwd)) !== requestedRoot) return undefined;
                if (context.agentSessionId && metadata.sessionId !== context.agentSessionId)
                    return undefined;
                return metadata;
            } catch {
                return undefined;
            }
        }),
    );
    const latest = matches
        .filter((value): value is ClaudeSessionMetadata => Boolean(value))
        .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];
    if (!latest) return undefined;
    return {
        sessionId: typeof latest.sessionId === 'string' ? latest.sessionId : undefined,
        status: claudeStatus(latest.status),
        title:
            typeof latest.name === 'string' && latest.name.trim() ? latest.name.trim() : undefined,
    };
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
