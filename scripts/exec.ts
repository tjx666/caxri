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
 * Normalizes Node's nullable exit code without hiding launch errors. Signal termination is always non-zero, matching
 * the repository scripts that previously implemented this listener pair.
 */
export function waitForChildExit(
    child: ChildProcess,
    options: WaitForChildExitOptions = {},
): Promise<number> {
    const event = options.event ?? 'exit';
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once(event, (code, signal) =>
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
