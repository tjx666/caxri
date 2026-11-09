import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { CaxriError } from '@caxri/protocol';

import type { AgentEnvironment } from '../../contract';
import { agentCommandEnvironment } from '../../rename';

const CODEX_APP_SERVER_DEFAULT_MAXIMUM_OUTPUT_BYTES = 128 * 1024;
const CODEX_APP_SERVER_TERMINATION_GRACE_MS = 1_000;
const CODEX_APP_SERVER_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_ERROR_DETAIL_MAX_LENGTH = 300;

interface CodexAppServerResponse {
    error?: unknown;
    id?: unknown;
    result?: unknown;
}

/**
 * Where and how a one-shot `codex app-server` runs, and what it is for: `purpose` names the operation in every error
 * this bridge authors ("Codex Session rename timed out").
 */
export interface CodexAppServerCallContext {
    executable: string;
    cwd: string;
    environment: AgentEnvironment;
    purpose: string;
    signal?: AbortSignal;
    /**
     * Arguments placed before `app-server`, such as `-c` overrides. None by default, so the call reads the user's own
     * config files.
     */
    rootArgs?: readonly string[];
    maximumOutputBytes?: number;
}

/**
 * Extracts the app-server's own JSON-RPC 2.0 `error.message` (issue caxri#1345), so a rejected call shows the CLI's
 * actual reason (not logged in, rate limited, thread not found) instead of only a generic failure. Bounded so a
 * pathological response cannot inflate a toast or its log record.
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
 * Reaps the one-shot app-server before settling. Merely sending a signal is insufficient: a delayed child could
 * otherwise apply an already-rejected write after a timeout or cancellation.
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
 * Runs `calls` in order on a one-shot `codex app-server --stdio` and returns their results, each request sent only
 * after the previous one answered. Every failure this bridge authors itself is thrown as a `CaxriError`: these strings
 * are Caxri constants and safe to log and show, whereas a raw `spawn`/`stdin` error can carry provider output and must
 * stay behind the caller's generic message.
 */
export async function callCodexAppServer(
    context: CodexAppServerCallContext,
    calls: ReadonlyArray<{ method: string; params: Record<string, unknown> }>,
): Promise<unknown[]> {
    const { purpose } = context;
    if (context.signal?.aborted)
        throw new CaxriError('CANCELLED', `Codex ${purpose} was cancelled`);
    const maximumOutputBytes =
        context.maximumOutputBytes ?? CODEX_APP_SERVER_DEFAULT_MAXIMUM_OUTPUT_BYTES;
    const environment = await agentCommandEnvironment(context.environment);
    return new Promise((resolve, reject) => {
        const child = spawn(
            context.executable,
            [...(context.rootArgs ?? []), 'app-server', '--stdio'],
            { cwd: context.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let buffer = '';
        let outputBytes = 0;
        let isSettled = false;
        const results: unknown[] = [];
        const timeout = setTimeout(() => {
            settle(new CaxriError('TIMEOUT', `Codex ${purpose} timed out`), undefined);
        }, CODEX_APP_SERVER_TIMEOUT_MS);

        const abort = (): void => {
            settle(new CaxriError('CANCELLED', `Codex ${purpose} was cancelled`), undefined);
        };
        context.signal?.addEventListener('abort', abort, { once: true });

        async function finalizeSettlement(
            error: Error | undefined,
            result: unknown[] | undefined,
        ): Promise<void> {
            try {
                await terminateCodexAppServer(child);
                if (error) reject(error);
                else resolve(result ?? []);
            } catch (terminationError) {
                reject(
                    terminationError instanceof Error
                        ? terminationError
                        : new CaxriError('UNAVAILABLE', 'Codex app-server termination failed'),
                );
            }
        }

        function settle(error: Error | undefined, result: unknown[] | undefined): void {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            context.signal?.removeEventListener('abort', abort);
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

        function sendCall(index: number): void {
            const call = calls.at(index);
            if (!call) {
                settle(undefined, results);
                return;
            }
            write({ id: index + 2, method: call.method, params: call.params });
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
                sendCall(0);
                return;
            }
            const index = typeof response.id === 'number' ? response.id - 2 : -1;
            if (index !== results.length || index >= calls.length) return;
            if (response.error !== undefined || response.result === undefined) {
                const detail = codexAppServerErrorDetail(response.error);
                settle(
                    new CaxriError(
                        'UNAVAILABLE',
                        `Codex app-server rejected the ${purpose}${detail ? `: ${detail}` : ''}`,
                    ),
                    undefined,
                );
                return;
            }
            results.push(response.result);
            sendCall(index + 1);
        }

        child.stdout.on('data', (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > maximumOutputBytes) {
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
            if (outputBytes > maximumOutputBytes)
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
