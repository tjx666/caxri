import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promisified `execFile` shared by repository scripts so each tool avoids re-declaring the `promisify(execFile)`
 * boilerplate. Scripts stay independent of `src/`, so this intentionally mirrors
 * `packages/system/src/filesystem/exec.ts`.
 */
export const execFileAsync = promisify(execFile);

export interface WaitForChildExitOptions {
    event?: 'close' | 'exit';
    nullExitCode?: number;
}

/**
 * Normalizes Node's nullable exit code without hiding launch errors. Late observers read the exit state already stored
 * on the child; signal termination is always non-zero, matching the repository scripts that previously implemented this
 * listener pair. A caller waiting for `close` still waits for stdio to close after process exit.
 */
export function waitForChildExit(
    child: ChildProcess,
    options: WaitForChildExitOptions = {},
): Promise<number> {
    const event = options.event ?? 'exit';
    if (event === 'exit') {
        if (typeof child.exitCode === 'number') return Promise.resolve(child.exitCode);
        if (child.signalCode) return Promise.resolve(1);
    }
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once(event, (code: number | null, signal: NodeJS.Signals | null) =>
            resolve(code ?? (signal ? 1 : (options.nullExitCode ?? 0))),
        );
    });
}

/**
 * Runs a structured-argv child process and returns its normalized exit code.
 */
export function runChildProcess(
    command: string,
    arguments_: readonly string[],
    options: SpawnOptions = {},
    waitOptions: WaitForChildExitOptions = {},
): Promise<number> {
    return waitForChildExit(spawn(command, arguments_, options), waitOptions);
}
