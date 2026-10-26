import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { execFileAsync } from '@caxri/system';

/**
 * How long each reaping stage (SIGTERM, then SIGKILL) waits for the group to empty.
 */
const TERMINATION_GRACE_MS = 1_000;

/**
 * How often the group reaper re-probes whether any member of the process group is still alive.
 */
const GROUP_PROBE_INTERVAL_MS = 25;

/**
 * Whether group `pgid` still has a member this process may signal. Signal 0 delivers nothing: `kill` fails with ESRCH
 * once the group is empty, and with EPERM when only members this user cannot signal remain, which nothing here could
 * stop either.
 */
export function isGroupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pgid, signal);
    } catch {
        // The group emptied after the last probe.
    }
}

async function hasGroupEmptiedWithin(pgid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isGroupAlive(pgid)) {
        if (Date.now() >= deadline) return false;
        // eslint-disable-next-line no-await-in-loop -- each probe must observe the group after the previous interval
        await delay(GROUP_PROBE_INTERVAL_MS);
    }
    return true;
}

/**
 * Stops every member of a child's process group: SIGTERM, a bounded grace while probing liveness, then SIGKILL. Takes
 * at most two grace periods, and returns at once when the group is already empty.
 *
 * The leader's exit does not end the group. A grandchild (an npm shim's native binary, a background tool an Agent
 * started) inherits the group, survives the leader, and would otherwise keep running with nobody reading its pipes.
 * Signaling `-pgid` after the leader is gone is still precise: POSIX keeps a process group ID reserved while any member
 * lives, so the kernel cannot hand that ID to an unrelated process or group until the probe reports the group empty,
 * and the reaper stops signaling there. Callers must therefore reap only a group they spawned and have not yet seen
 * empty.
 */
export async function reapGroup(pgid: number): Promise<void> {
    if (!isGroupAlive(pgid)) return;
    signalGroup(pgid, 'SIGTERM');
    if (await hasGroupEmptiedWithin(pgid, TERMINATION_GRACE_MS)) return;
    signalGroup(pgid, 'SIGKILL');
    await hasGroupEmptiedWithin(pgid, TERMINATION_GRACE_MS);
}

export interface ProcessGroupCommandOptions {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    /**
     * Largest stdout or stderr, in bytes, before the command is stopped and fails with
     * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
     */
    maxBuffer: number;
    signal?: AbortSignal;
    /**
     * Milliseconds before the command is stopped and fails with `killed: true`; zero disables the limit.
     */
    timeout: number;
}

/**
 * The failure shape `execFile` callers already classify: `code` is the exit code or a spawn errno, `killed` marks a
 * command Caxri stopped on its timeout.
 */
type CommandError = Error & {
    code?: number | string | null;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
};

function commandError(
    message: string,
    fields: Omit<CommandError, 'message' | 'name'>,
): CommandError {
    return Object.assign(new Error(message), fields);
}

/**
 * Matches the `AbortError` `execFile` rejects with when its signal aborts.
 */
class CommandAbortError extends Error {
    override readonly name = 'AbortError';
    readonly code = 'ABORT_ERR';

    constructor(reason: unknown) {
        super('The operation was aborted', { cause: reason });
    }
}

/**
 * `execFile` with the child leading its own process group, so a timeout, an output overflow, or an abort stops the
 * child's whole tree instead of the child alone, and the promise settles only after that tree is gone.
 *
 * `execFile` signals just the direct child and does not forward `detached` to `spawn`. A CLI that runs its real work in
 * a grandchild therefore outlives the timeout with its pipes closed. The Vercel CLI does exactly that on macOS (its
 * Node shim `spawnSync`s a native binary), and the orphan's first write fails with `EPIPE`, which sends the CLI's error
 * handler into an unbounded loop until V8 aborts at ~4 GiB (https://github.com/vercel/vercel/issues/17528). Project
 * Status polls `vc` for several branches each round, so the orphans accumulated until macOS panicked on memory
 * exhaustion (issue #2637).
 *
 * A command that exits on its own, with any exit code, keeps its group: a CLI may deliberately leave a daemon behind,
 * and only a command Caxri itself stopped has lost the reader of its pipes. Rejections mirror `execFile`'s error fields
 * (`code`, `killed`, `signal`, `stdout`, `stderr`), and an abort rejects with an `AbortError`. Windows has no process
 * groups and keeps `execFile`.
 */
export function execFileInProcessGroup(
    executable: string,
    arguments_: readonly string[],
    options: ProcessGroupCommandOptions,
): Promise<{ stderr: string; stdout: string }> {
    if (process.platform === 'win32')
        return execFileAsync(executable, [...arguments_], { ...options, encoding: 'utf8' });
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new CommandAbortError(signal.reason));
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], {
            ...(options.cwd !== undefined && { cwd: options.cwd }),
            env: options.env,
            detached: true,
            // Nothing writes to these commands; a pipe nobody closes would only let one block on reading it.
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = { stderr: [] as Buffer[], stdout: [] as Buffer[] };
        const bytes = { stderr: 0, stdout: 0 };
        /**
         * Why Caxri stopped the command, which decides the rejection once the child closes.
         */
        let stopped: CommandError | undefined;
        let reaping: Promise<void> | undefined;

        const text = (stream: 'stderr' | 'stdout') =>
            Buffer.concat(output[stream]).toString('utf8');
        const stop = (reason: CommandError) => {
            stopped ??= reason;
            const { pid } = child;
            if (pid === undefined || reaping) return;
            reaping = (async () => {
                await reapGroup(pid);
                /**
                 * A descendant that left the group (`setsid`) can hold the pipes open forever; dropping our read ends
                 * lets `close` fire without it.
                 */
                child.stdout.destroy();
                child.stderr.destroy();
            })();
        };
        const onAbort = () => stop(new CommandAbortError(signal?.reason));
        const timer =
            options.timeout > 0
                ? setTimeout(
                      () =>
                          stop(
                              commandError(`Command timed out: ${executable}`, {
                                  code: null,
                                  killed: true,
                                  signal: 'SIGTERM',
                              }),
                          ),
                      options.timeout,
                  )
                : undefined;
        signal?.addEventListener('abort', onAbort, { once: true });

        for (const stream of ['stdout', 'stderr'] as const) {
            child[stream].on('data', (chunk: Buffer) => {
                bytes[stream] += chunk.length;
                if (bytes[stream] > options.maxBuffer) {
                    stop(
                        commandError(`${stream} maxBuffer length exceeded`, {
                            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                            killed: true,
                            signal: 'SIGTERM',
                        }),
                    );
                    return;
                }
                output[stream].push(chunk);
            });
        }

        let spawnError: Error | undefined;
        child.once('error', (error) => {
            spawnError ??= error;
        });
        child.once('close', (code: number | null, exitSignal: NodeJS.Signals | null) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            const stdout = text('stdout');
            const stderr = text('stderr');
            void (async () => {
                await reaping;
                if (stopped) {
                    reject(Object.assign(stopped, { stderr, stdout }));
                    return;
                }
                if (spawnError) {
                    reject(Object.assign(spawnError, { stderr, stdout }));
                    return;
                }
                if (code === 0) {
                    resolve({ stderr, stdout });
                    return;
                }
                reject(
                    commandError(`Command failed: ${executable}\n${stderr}`, {
                        code,
                        killed: false,
                        signal: exitSignal,
                        stderr,
                        stdout,
                    }),
                );
            })();
        });
    });
}
