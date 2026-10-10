import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { CaxriError } from '@caxri/protocol';

import type { AgentProviderSessionRenameContext, AgentSessionRenameResult } from '../../contract';
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';

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
 * actual reason (not logged in, rate limited, thread not found) instead of only "Codex app-server rejected the Session
 * rename". Bounded so a pathological response cannot inflate the rename toast or its log record.
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
