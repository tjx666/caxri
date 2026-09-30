import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import Database from 'better-sqlite3';

import type {
    AgentProviderDescriptor,
    AgentProviderSessionRenameContext,
    AgentSessionRenameResult,
    AgentSnapshotContext,
    LocalAgentState,
} from '../../contract';
import { canonicalPath, isOpaqueAgentSessionId, projectDirectories } from '../../contract';
import type { ProcessOpenFile } from '../../process-detection';
import { detectForegroundAgentOpenFiles } from '../../process-detection';
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';
import { AGENT_TITLE_SYSTEM_INSTRUCTIONS } from '../../title-generation';
import { codexDelegationAdapter, codexPrimaryTurnFailure } from './delegation';
import { codexHookAdapter } from './hooks';
import { generateCodexLowCostText } from './low-cost-generation';
import { resolveCodexHome, resolveCodexStateDirectories } from './paths';
import { CODEX_ROLLOUT_NAME_PATTERN, parseCodexRolloutName } from './rollouts';
import type { SqliteColumn } from './state-databases';
import { findCodexStateDatabases } from './state-databases';
import { appendCodexTimelineRecord } from './timeline';
import { locateCodexTranscript } from './transcript';
import { readCodexTurnState, readCodexTurnStatus } from './turn-state';

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

const CODEX_APP_SERVER_ERROR_DETAIL_MAX_LENGTH = 300;

/**
 * Extracts the app-server's own JSON-RPC 2.0 `error.message` (issue caxri#1345), so a rejected rename shows the CLI's
 * actual reason — not logged in, rate limited, thread not found — instead of only "Codex app-server rejected the
 * Session rename". Bounded so a pathological response cannot inflate the rename toast or its log record.
 */
function codexAppServerErrorDetail(error: unknown): string | undefined {
    const message = (error as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string') return undefined;
    const detail = message.trim();
    if (!detail) return undefined;
    return detail.length > CODEX_APP_SERVER_ERROR_DETAIL_MAX_LENGTH
        ? `${detail.slice(0, CODEX_APP_SERVER_ERROR_DETAIL_MAX_LENGTH)}…`
        : detail;
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

/**
 * Every failure this bridge authors itself is thrown as a `CaxriError`, so `throwAgentRenameError` passes it through
 * instead of flattening it into "Codex could not rename the Agent session". The distinction is deliberate: these
 * strings are Caxri constants and safe to log and show, whereas a raw `spawn`/`stdin` error can carry provider output
 * and must stay behind the generic message.
 */
async function callCodexAppServer(
    context: AgentProviderSessionRenameContext,
    method: string,
    parameters: Record<string, unknown>,
): Promise<unknown> {
    if (context.signal?.aborted)
        throw new CaxriError('CANCELLED', 'Codex Session rename was cancelled');
    const environment = await agentCommandEnvironment(context.environment);
    return new Promise((resolve, reject) => {
        const child = spawn(context.executable, ['app-server', '--stdio'], {
            cwd: context.cwd,
            env: environment,
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
                        : new CaxriError('UNAVAILABLE', 'Codex app-server termination failed'),
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
                    error instanceof Error
                        ? error
                        : new CaxriError('UNAVAILABLE', 'Codex app-server input failed'),
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
                settle(
                    new CaxriError('UNAVAILABLE', 'Codex app-server returned invalid JSON'),
                    undefined,
                );
                return;
            }
            if (response.id === 1) {
                if (response.error !== undefined || response.result === undefined) {
                    const detail = codexAppServerErrorDetail(response.error);
                    settle(
                        new CaxriError(
                            'UNAVAILABLE',
                            `Codex app-server initialization failed${detail ? `: ${detail}` : ''}`,
                        ),
                        undefined,
                    );
                    return;
                }
                write({ method: 'initialized' });
                write({ id: 2, method, params: parameters });
                return;
            }
            if (response.id !== 2) return;
            if (response.error !== undefined || response.result === undefined) {
                const detail = codexAppServerErrorDetail(response.error);
                settle(
                    new CaxriError(
                        'UNAVAILABLE',
                        `Codex app-server rejected the Session rename${detail ? `: ${detail}` : ''}`,
                    ),
                    undefined,
                );
                return;
            }
            settle(undefined, response.result);
        }

        child.stdout.on('data', (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > CODEX_APP_SERVER_MAXIMUM_OUTPUT_BYTES) {
                settle(
                    new CaxriError(
                        'UNAVAILABLE',
                        'Codex app-server output exceeded its safety limit',
                    ),
                    undefined,
                );
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
                settle(
                    new CaxriError(
                        'UNAVAILABLE',
                        'Codex app-server output exceeded its safety limit',
                    ),
                    undefined,
                );
        });
        child.once('error', (error) => settle(error, undefined));
        child.stdin.once('error', (error) => settle(error, undefined));
        child.once('exit', () => {
            if (buffer.trim()) handleLine(buffer);
            if (!isSettled)
                settle(
                    new CaxriError('UNAVAILABLE', 'Codex app-server exited before replying'),
                    undefined,
                );
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

interface CodexThreadRow {
    id: string;
    session_is_subagent?: number | null;
    title?: string;
    tokens_used?: number;
}

const CODEX_PROVISIONAL_TITLE_CHARACTERS = 36;
const CODEX_THREAD_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i;
/**
 * `xxxxxxxx-xxxx`: the 48-bit big-endian millisecond timestamp a UUIDv7 carries in its first two groups, which sorts
 * lexicographically in creation order.
 */
const CODEX_THREAD_ID_TIMESTAMP_CHARACTERS = 13;
/**
 * How many of a Codex process's open threads may be inspected before the probe gives up. Only the foreground
 * conversation and threads it spawned can appear here, so a deeper set means the process is running background work
 * this probe cannot attribute — and spending one database query per candidate is the cost being bounded.
 */
const MAX_CODEX_OPEN_THREAD_CANDIDATES = 4;
const CODEX_SQLITE_WHITESPACE =
    'char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)';

function isWritableOpenFile(access: string): boolean {
    const normalized = access.trim().toLowerCase();
    return normalized === 'u' || normalized.includes('w');
}

/**
 * Every Codex thread held open for writing below the canonical Codex sessions root, newest first. A missing, malformed,
 * or foreign-root file contributes nothing, so an unreadable file set still yields no identity at all.
 *
 * More than one open rollout is the normal shape rather than an error: a `/new` inside a running Codex keeps the
 * conversation it just left open for minutes while it writes the replacement, and a background thread holds its own
 * rollout too. Refusing to decide there is what let a Terminal keep a conversation the user had already abandoned — the
 * binding never caught up, so restarting Caxri resumed the retired thread instead of the visible one. Ordering is the
 * thread id's own UUIDv7 timestamp (its first 48 bits, which {@link CODEX_THREAD_ID_PATTERN} already requires) rather
 * than the file name's local-time stamp, so a DST fall-back hour cannot reverse two threads.
 */
export function codexSessionIdsFromOpenFiles(
    files: readonly ProcessOpenFile[],
    sessionsRoot: string,
): string[] {
    if (!isAbsolute(sessionsRoot)) return [];
    const sessionIds = new Set<string>();
    for (const file of files) {
        if (!isWritableOpenFile(file.access)) continue;
        const suffix = relative(sessionsRoot, file.path);
        if (
            suffix === '' ||
            isAbsolute(suffix) ||
            suffix.startsWith(`..${sep}`) ||
            suffix.split(sep).length !== 4
        )
            continue;
        // A reverted thread's live rollout carries its rollout ID after the stable thread ID.
        const sessionId = parseCodexRolloutName(basename(file.path))?.threadId;
        if (!sessionId || !CODEX_THREAD_ID_PATTERN.test(sessionId)) continue;
        if (!isOpaqueAgentSessionId(sessionId)) continue;
        sessionIds.add(sessionId);
    }
    return [...sessionIds].toSorted((left, right) => {
        const byCreation = right
            .slice(0, CODEX_THREAD_ID_TIMESTAMP_CHARACTERS)
            .toLowerCase()
            .localeCompare(left.slice(0, CODEX_THREAD_ID_TIMESTAMP_CHARACTERS).toLowerCase());
        // Two threads created inside the same millisecond still need one stable order.
        return byCreation === 0 ? right.localeCompare(left) : byCreation;
    });
}

/**
 * Resolves identity from the rollout files the Codex process itself holds open.
 *
 * The three outcomes are distinct and the caller must not collapse them: a state means the process was identified,
 * `undefined` means the probe could not decide and heuristic discovery may still run, and `null` means the probe proved
 * this process owns no claimable thread — heuristic discovery must then stay out.
 */
async function readCodexStateFromProcess(
    context: AgentSnapshotContext,
    environment: Parameters<typeof resolveCodexHome>[0],
    stateDirectories: string[],
): Promise<LocalAgentState | null | undefined> {
    if (
        context.agentSessionId ||
        context.shellPid === undefined ||
        context.processState !== 'running'
    )
        return undefined;
    let sessionsRoot: string;
    try {
        sessionsRoot = await realpath(join(resolveCodexHome(environment), 'sessions'));
    } catch {
        return undefined;
    }
    const openFiles = await detectForegroundAgentOpenFiles(context.shellPid, 'codex');
    if (openFiles.length === 0) return undefined;
    const candidateOpenFiles = openFiles.filter(
        (file) =>
            isWritableOpenFile(file.access) && CODEX_ROLLOUT_NAME_PATTERN.test(basename(file.path)),
    );
    /**
     * The probe listed this process's files and found no rollout among them. Codex only creates a thread once it
     * receives a first message, so this is proof of a thread-less Agent rather than a failed probe — `openFiles` is
     * empty when the probe itself is unusable, and that case returned above.
     *
     * Falling through to cwd discovery here is what let an idle Terminal adopt the next thread a sibling Session
     * started in the same directory: that query bounds candidates only by "created after this Terminal started", so a
     * Terminal waiting at an empty prompt claimed a thread created minutes later, and its automatic title then followed
     * the stolen binding.
     *
     * @see https://github.com/tjx666/caxri/issues/795
     */
    if (candidateOpenFiles.length === 0) return null;
    const canonicalFiles = (
        await Promise.all(
            candidateOpenFiles.map(async (file) => {
                try {
                    return { ...file, path: await realpath(file.path) };
                } catch {
                    return;
                }
            }),
        )
    ).filter((file): file is ProcessOpenFile => file !== undefined);
    const sessionIds = codexSessionIdsFromOpenFiles(canonicalFiles, sessionsRoot);
    if (sessionIds.length === 0) return undefined;
    /**
     * Newest first, because the thread this process started last is the one the user is talking to. An older sibling is
     * considered only when the newer one turns out to be a spawned subagent, whose rollout this process holds open just
     * as it does the conversation's.
     */
    const excluded = new Set(context.excludedAgentSessionIds);
    for (const sessionId of sessionIds.slice(0, MAX_CODEX_OPEN_THREAD_CANDIDATES)) {
        /**
         * The thread this process holds open is already bound to another Terminal. Heuristic discovery would then hand
         * this Terminal a different Session's thread, which is worse than reporting no identity at all.
         */
        if (excluded.has(sessionId)) return null;
        // eslint-disable-next-line no-await-in-loop -- each candidate is only reached once the newer one is disproved
        const state = await readCodexState(
            { ...context, agentSessionId: sessionId },
            stateDirectories,
        );
        /**
         * An unknown thread (`undefined`) is not a subagent proof, so it still answers: the provider store simply has
         * not flushed a conversation this process demonstrably owns, and the caller's own retry is the right recovery.
         */
        if (state?.sessionIsSubagent !== true) return state;
    }
    return null;
}

/**
 * Queries only a capability-detected Codex thread index and never opens rollout transcripts.
 */
async function readCodexState(
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
     * `token_count`, and `turn_aborted` — none of them a rename. Both writers go through the same app-server
     * `thread/name/set` this provider itself calls for {@link renameCodexSession}.
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

export const codexProvider: AgentProviderDescriptor = {
    delegation: codexDelegationAdapter,
    readTurnStatus: (context, environment) =>
        readCodexTurnStatus(context, resolveCodexStateDirectories(environment)),
    resolvePrimaryTurnFailure: codexPrimaryTurnFailure,
    generateTitle: (context) =>
        generateCodexLowCostText(
            context,
            AGENT_TITLE_SYSTEM_INSTRUCTIONS,
            'Automatic Session naming',
        ),
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
    /**
     * Codex 0.154 skips implicit shared-daemon reuse for CLI config overrides. A local backend must inherit this
     * Terminal's hook identity and credentials; Caxri owns cross-Session messaging. This also disables auto recap.
     * https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/lib.rs#L988-L998
     */
    managedLaunchArguments: ['-c', 'tui.auto_recap=false'],
    readState: async (context, environment) => {
        const stateDirectories = resolveCodexStateDirectories(environment);
        const processState = await readCodexStateFromProcess(
            context,
            environment,
            stateDirectories,
        );
        if (processState !== undefined || context.requireForegroundProcessIdentity)
            return processState ?? undefined;
        return readCodexState(context, stateDirectories);
    },
    renameSession: renameCodexSession,
    locateTranscript: (context, environment, signal) =>
        locateCodexTranscript(context, environment, signal),
    resumeArguments: (agentSessionId) => ['resume', agentSessionId],
    timelineProjector: appendCodexTimelineRecord,
};
