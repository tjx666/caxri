import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { CaxriError } from '@caxri/protocol';

const DEFAULT_MAXIMUM_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

export interface AgentTextCommandOptions {
    arguments: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    input: string;
    limits?: {
        maximumOutputBytes?: number;
        terminationGraceMs?: number;
        timeoutMs?: number;
    };
    operation: string;
    signal?: AbortSignal;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function didExit(exited: Promise<void>): Promise<true> {
    await exited;
    return true;
}

async function terminate(
    child: ChildProcessWithoutNullStreams,
    terminationGraceMs: number,
): Promise<void> {
    child.stdin.end();
    if (child.pid === undefined || hasExited(child)) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
        didExit(exited),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), terminationGraceMs);
            timer.unref();
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (!graceful && !hasExited(child)) child.kill('SIGKILL');
    await exited;
}

/**
 * Sends user-derived prompt material only over stdin. Keeping it out of argv prevents local process listings,
 * diagnostics, and structured logs from exposing its contents.
 */
export function runAgentTextCommand(options: AgentTextCommandOptions): Promise<string> {
    if (options.signal?.aborted)
        return Promise.reject(new CaxriError('CANCELLED', `${options.operation} was cancelled`));
    return new Promise((resolve, reject) => {
        const child = spawn(options.executable, [...options.arguments], {
            cwd: options.cwd,
            env: options.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdoutDecoder = new StringDecoder('utf8');
        let stdout = '';
        let outputBytes = 0;
        let isSettled = false;
        const timeout = setTimeout(
            () => settle(new CaxriError('TIMEOUT', `${options.operation} timed out`)),
            options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        timeout.unref();
        const abort = (): void =>
            settle(new CaxriError('CANCELLED', `${options.operation} was cancelled`));
        options.signal?.addEventListener('abort', abort, { once: true });

        function settle(error?: Error): void {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            // eslint-disable-next-line no-void -- settlement owns subprocess reaping before resolving the outer promise
            void finishSettlement(error);
        }

        async function finishSettlement(error?: Error): Promise<void> {
            try {
                await terminate(
                    child,
                    options.limits?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
                );
                if (error) reject(error);
                else resolve(stdout);
            } catch (terminationError: unknown) {
                reject(
                    terminationError instanceof Error
                        ? terminationError
                        : new Error(`${options.operation} process termination failed`),
                );
            }
        }

        const observeOutput = (chunk: Buffer, shouldCapture: boolean): void => {
            outputBytes += chunk.byteLength;
            if (
                outputBytes > (options.limits?.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES)
            ) {
                settle(new Error(`${options.operation} output exceeded its safety limit`));
                return;
            }
            if (shouldCapture) stdout += stdoutDecoder.write(chunk);
        };
        child.stdout.on('data', (chunk: Buffer) => observeOutput(chunk, true));
        child.stdout.once('end', () => {
            stdout += stdoutDecoder.end();
        });
        child.stderr.on('data', (chunk: Buffer) => observeOutput(chunk, false));
        child.once('error', (error) => settle(error));
        child.stdin.once('error', (error) => settle(error));
        /**
         * `close` follows stdio drain, so the final decoded summary cannot race process exit.
         */
        child.once('close', (code) => {
            if (!isSettled)
                settle(
                    code === 0
                        ? undefined
                        : Object.assign(new Error(`${options.operation} failed`), {
                              exitCode: code,
                          }),
                );
        });
        child.stdin.end(options.input);
    });
}
