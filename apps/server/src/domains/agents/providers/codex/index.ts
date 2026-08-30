import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';
import Database from 'better-sqlite3';

import type {
    AgentEnvironment,
    AgentProviderDescriptor,
    AgentProviderSessionRenameContext,
    AgentSessionRenameResult,
    AgentSnapshotContext,
    LocalAgentState,
} from '../../contract';
import { canonicalPath, projectDirectories } from '../../contract';
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';
import { codexHookAdapter } from './hooks';

/**
 * A one-shot app-server sees the active conversation as an unloaded thread; 0.110.0 made that rename path durable.
 *
 * @see https://github.com/openai/codex/pull/13282
 */
const CODEX_RENAME_MINIMUM_VERSION = '0.110.0';
const CODEX_APP_SERVER_MAXIMUM_OUTPUT_BYTES = 128 * 1024;
const CODEX_APP_SERVER_TERMINATION_GRACE_MS = 1_000;
const CODEX_APP_SERVER_TIMEOUT_MS = 10_000;

interface CodexAppServerResponse {
    error?: unknown;
    id?: unknown;
    result?: unknown;
}

function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Reaps the one-shot app-server before releasing the Session rename queue. Merely sending a signal is insufficient: a
 * delayed child could otherwise apply an already-rejected rename after a timeout or cancellation.
 */
async function terminateCodexAppServer(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stdin.end();
    if (child.pid === undefined || hasChildExited(child)) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    let forceTimer: NodeJS.Timeout | undefined;
    const hasExited = async (): Promise<true> => {
        await exited;
        return true;
    };
    const exitedGracefully = await Promise.race([
        hasExited(),
        new Promise<false>((resolve) => {
            forceTimer = setTimeout(() => resolve(false), CODEX_APP_SERVER_TERMINATION_GRACE_MS);
            forceTimer.unref();
        }),
    ]);
    if (forceTimer) clearTimeout(forceTimer);
    if (!exitedGracefully && !hasChildExited(child)) child.kill('SIGKILL');
    await exited;
}

function callCodexAppServer(
    context: AgentProviderSessionRenameContext,
    method: string,
    parameters: Record<string, unknown>,
): Promise<unknown> {
    if (context.signal?.aborted)
        return Promise.reject(new CaxriError('CANCELLED', 'Codex Session rename was cancelled'));
    return new Promise((resolve, reject) => {
        const child = spawn(context.executable, ['app-server', '--stdio'], {
            cwd: context.cwd,
            env: agentCommandEnvironment(context.environment),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '';
        let outputBytes = 0;
        let isSettled = false;
        const timeout = setTimeout(() => {
            settle(new CaxriError('TIMEOUT', 'Codex Session rename timed out'), undefined);
        }, CODEX_APP_SERVER_TIMEOUT_MS);

        const abort = (): void => {
            settle(new CaxriError('CANCELLED', 'Codex Session rename was cancelled'), undefined);
        };
        context.signal?.addEventListener('abort', abort, { once: true });

        async function finalizeSettlement(
            error: Error | undefined,
            result: unknown,
        ): Promise<void> {
            try {
                await terminateCodexAppServer(child);
                if (error) reject(error);
                else resolve(result);
            } catch (terminationError) {
                reject(
                    terminationError instanceof Error
                        ? terminationError
                        : new Error('Codex app-server termination failed'),
                );
            }
        }

        function settle(error: Error | undefined, result: unknown): void {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            context.signal?.removeEventListener('abort', abort);
            // eslint-disable-next-line no-void -- settlement owns both outcomes
            void finalizeSettlement(error, result);
        }

        function write(message: Record<string, unknown>): void {
            try {
                child.stdin.write(`${JSON.stringify(message)}\n`);
            } catch (error) {
                settle(
                    error instanceof Error ? error : new Error('Codex app-server input failed'),
                    undefined,
                );
            }
        }

        function handleLine(line: string): void {
            if (!line.trim()) return;
            let response: CodexAppServerResponse;
            try {
                response = JSON.parse(line) as CodexAppServerResponse;
            } catch {
                settle(new Error('Codex app-server returned invalid JSON'), undefined);
                return;
            }
            if (response.id === 1) {
                if (response.error !== undefined || response.result === undefined) {
                    settle(new Error('Codex app-server initialization failed'), undefined);
                    return;
                }
                write({ method: 'initialized' });
                write({ id: 2, method, params: parameters });
                return;
            }
            if (response.id !== 2) return;
            if (response.error !== undefined || response.result === undefined) {
                settle(new Error('Codex app-server rejected the Session rename'), undefined);
                return;
            }
            settle(undefined, response.result);
        }

        child.stdout.on('data', (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > CODEX_APP_SERVER_MAXIMUM_OUTPUT_BYTES) {
                settle(new Error('Codex app-server output exceeded its safety limit'), undefined);
                return;
            }
            buffer += chunk.toString('utf8');
            let newline = buffer.indexOf('\n');
            while (newline !== -1 && !isSettled) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                handleLine(line);
                newline = buffer.indexOf('\n');
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > CODEX_APP_SERVER_MAXIMUM_OUTPUT_BYTES)
                settle(new Error('Codex app-server output exceeded its safety limit'), undefined);
        });
        child.once('error', (error) => settle(error, undefined));
        child.stdin.once('error', (error) => settle(error, undefined));
        child.once('exit', () => {
            if (buffer.trim()) handleLine(buffer);
            if (!isSettled) settle(new Error('Codex app-server exited before replying'), undefined);
        });

        write({
            id: 1,
            method: 'initialize',
            params: {
                clientInfo: { name: 'caxri', title: 'Caxri', version: '1.0.0' },
            },
        });
    });
}

export async function renameCodexSession(
    context: AgentProviderSessionRenameContext,
): Promise<AgentSessionRenameResult> {
    assertAgentRenameVersion('codex', context.version, CODEX_RENAME_MINIMUM_VERSION);
    try {
        await callCodexAppServer(context, 'thread/name/set', {
            threadId: context.agentSessionId,
            name: context.displayTitle,
        });
        return { displayTitle: context.displayTitle };
    } catch (error) {
        throwAgentRenameError('codex', error, context.signal);
    }
}

interface SqliteColumn {
    name: string;
}

interface CodexThreadRow {
    id: string;
    title: string;
    tokens_used?: number;
}

interface CodexTurnRow {
    status: string;
}

async function findCodexDatabases(
    directories: string[],
    namePattern = /^state_\d+\.sqlite$/,
): Promise<string[]> {
    const groups = await mapWithConcurrency([...new Set(directories)], 4, async (directory) => {
        try {
            const names = await readdir(directory);
            return names
                .filter((name) => namePattern.test(name))
                .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
                .map((name) => join(directory, name));
        } catch {
            /**
             * Missing or unreadable state directories are normal capability misses.
             */
            return [];
        }
    });
    return groups.flat();
}

async function readCodexTurnStatus(
    context: AgentSnapshotContext,
    stateDirectories: string[],
): Promise<LocalAgentState['status']> {
    if (!context.agentSessionId || !context.agentTurnId) return undefined;
    const databasePaths = await findCodexDatabases(
        stateDirectories,
        /^thread_history_\d+\.sqlite$/,
    );
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
            const row = database
                .prepare(
                    'SELECT status FROM thread_turns WHERE thread_id = ? AND turn_id = ? LIMIT 1',
                )
                .get(context.agentSessionId, context.agentTurnId) as CodexTurnRow | undefined;
            if (row?.status === 'inProgress') return 'running';
            if (row?.status === 'failed') return 'failed';
            if (row?.status === 'completed' || row?.status === 'interrupted') return 'completed';
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

/**
 * Queries only a capability-detected Codex thread index and never opens rollout transcripts.
 */
async function readCodexState(
    context: AgentSnapshotContext,
    stateDirectories: string[],
): Promise<LocalAgentState | undefined> {
    const requestedRoots = [...new Set([context.rootPath, await canonicalPath(context.rootPath)])];
    const databasePaths = await findCodexDatabases(stateDirectories);
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
            if (['id', 'cwd', 'title'].some((column) => !columns.has(column))) continue;
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
                : [...new Set(context.excludedAgentSessionIds)].filter(Boolean);
            if (!timestampExpression && !context.agentSessionId && context.startedAt) continue;
            const excluded =
                excludedSessionIds.length > 0
                    ? `id NOT IN (${excludedSessionIds.map(() => '?').join(', ')}) AND `
                    : '';
            const started =
                timestampExpression && !context.agentSessionId && context.startedAt
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
    return {
        sessionId: selectedRow.id,
        status: await readCodexTurnStatus(context, stateDirectories),
        title: selectedRow.title.trim() || undefined,
        usage:
            typeof selectedRow.tokens_used === 'number' && selectedRow.tokens_used > 0
                ? [{ label: 'Tokens', value: selectedRow.tokens_used.toLocaleString('en-US') }]
                : undefined,
    };
}

/**
 * Resolves the ordered set of directories Codex may keep its thread index SQLite databases in, from generic environment
 * inputs. `CODEX_SQLITE_HOME` takes priority when set, followed by Codex's own `sqlite` subdirectory and its home
 * directory, mirroring Codex's own resolution order.
 */
function resolveCodexStateDirectories(environment: AgentEnvironment): string[] {
    // `||` (not `??`) is deliberate: `CODEX_HOME=''` is not a usable override path either.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid override path either
    const codexHome = environment.variables.CODEX_HOME || join(environment.homeDirectory, '.codex');
    const sqliteHome = environment.variables.CODEX_SQLITE_HOME;
    return [...(sqliteHome ? [resolve(sqliteHome)] : []), join(codexHome, 'sqlite'), codexHome];
}

function resolveCodexHome(environment: AgentEnvironment): string {
    // `||` is deliberate: an empty override is not a usable configuration root.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid override path either
    return resolve(environment.variables.CODEX_HOME || join(environment.homeDirectory, '.codex'));
}

export const codexProvider: AgentProviderDescriptor = {
    actions: {
        roots: (context, environment) => [
            {
                directory: join(resolveCodexHome(environment), 'skills'),
                kind: 'skills',
                scope: 'legacy',
            },
            {
                directory: join(environment.homeDirectory, '.agents', 'skills'),
                kind: 'skills',
                scope: 'global',
            },
            ...projectDirectories(context).flatMap((directory) => [
                {
                    boundaryDirectory: context.projectRoot,
                    directory: join(directory, '.codex', 'skills'),
                    kind: 'skills' as const,
                    scope: 'legacy' as const,
                },
                {
                    boundaryDirectory: context.projectRoot,
                    directory: join(directory, '.agents', 'skills'),
                    kind: 'skills' as const,
                    scope: 'project' as const,
                },
            ]),
        ],
        skillInvocation: (name) => `$${name}`,
    },
    hooks: codexHookAdapter,
    id: 'codex',
    readState: (context, environment) =>
        readCodexState(context, resolveCodexStateDirectories(environment)),
    renameSession: renameCodexSession,
    resumeArguments: (agentSessionId) => ['resume', agentSessionId],
};
