import type { Buffer } from 'node:buffer';
import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';

import { execFileAsync } from '../../../../scripts/exec';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ProcessFailure extends Error {
    code?: number | string;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
}

export class CommandError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
    ) {
        super(message);
    }
}

export async function runCapture(
    command: string,
    arguments_: string[],
    cwd: string,
): Promise<string> {
    try {
        const { stdout } = await execFileAsync(command, arguments_, {
            cwd,
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT_BYTES,
        });
        return stdout;
    } catch (error) {
        const failure = error as ProcessFailure;
        const details = [failure.stdout, failure.stderr]
            .map((value) => value?.toString().trim())
            .filter(Boolean)
            .join('\n');
        throw new CommandError(details || failure.message);
    }
}

export async function runInherited(
    command: string,
    arguments_: string[],
    options: SpawnOptions & { cwd: string; stdoutToStderr?: boolean },
): Promise<number> {
    const { stdoutToStderr = false, ...spawnOptions } = options;
    const child = spawn(command, arguments_, {
        ...spawnOptions,
        stdio: stdoutToStderr ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    if (stdoutToStderr) child.stdout?.pipe(process.stderr);
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) reject(new CommandError(`${command} exited with ${signal}`));
            else resolve(code ?? 1);
        });
    });
}

/**
 * Hash start time plus command so PID reuse is detectable without persisting command arguments.
 */
export async function getProcessIdentity(pid: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
        const output = await runCapture(
            'ps',
            ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
            process.cwd(),
        );
        const identity = output.trim();
        return identity ? createHash('sha256').update(identity).digest('hex') : undefined;
    } catch {
        return undefined;
    }
}

export async function isProcessIdentityAlive(pid: number, identity: string): Promise<boolean> {
    return (await getProcessIdentity(pid)) === identity;
}
