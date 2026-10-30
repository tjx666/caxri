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
            // `ps lstart` is localized; process ownership parsing requires the C locale.
            env: { ...process.env, LC_ALL: 'C' },
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

const PS_ATTEMPTS = 3;
const PS_RETRY_DELAY_MS = 50;

type ProcessProbe =
    { kind: 'absent' } | { kind: 'present'; identity: string } | { kind: 'unknown' };

/**
 * Reads one process's identity. `ps -p <pid>` exits 1 with empty output only when the PID does not exist; any other
 * failure (spawn EAGAIN, timeout, load-induced error) says nothing about the process and must stay `unknown`.
 */
async function probeProcess(pid: number): Promise<ProcessProbe> {
    try {
        const { stdout } = await execFileAsync(
            'ps',
            ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                // `ps lstart` is localized; process ownership parsing requires the C locale.
                env: { ...process.env, LC_ALL: 'C' },
                maxBuffer: MAX_OUTPUT_BYTES,
            },
        );
        const identity = stdout.trim();
        return identity
            ? { kind: 'present', identity: createHash('sha256').update(identity).digest('hex') }
            : { kind: 'absent' };
    } catch (error) {
        const failure = error as ProcessFailure;
        const output = [failure.stdout, failure.stderr]
            .map((value) => value?.toString().trim())
            .filter(Boolean)
            .join('');
        return !output && failure.code === 1 ? { kind: 'absent' } : { kind: 'unknown' };
    }
}

async function probeProcessWithRetry(pid: number): Promise<ProcessProbe> {
    let probe: ProcessProbe = { kind: 'unknown' };
    /* eslint-disable no-await-in-loop -- probes are deliberately sequential with a delay between them */
    for (let attempt = 0; attempt < PS_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, PS_RETRY_DELAY_MS));
        probe = await probeProcess(pid);
        if (probe.kind !== 'unknown') return probe;
    }
    /* eslint-enable no-await-in-loop */
    return probe;
}

/**
 * Hash start time plus command so PID reuse is detectable without persisting command arguments.
 */
export async function getProcessIdentity(pid: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const probe = await probeProcessWithRetry(pid);
    return probe.kind === 'present' ? probe.identity : undefined;
}

/**
 * Fails closed: when `ps` keeps failing for a reason other than "no such process", the owner is reported alive so a
 * transient probe error under load can never let a live lease or lock be reclaimed as stale.
 */
export async function isProcessIdentityAlive(pid: number, identity: string): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const probe = await probeProcessWithRetry(pid);
    if (probe.kind === 'unknown') return true;
    return probe.kind === 'present' && probe.identity === identity;
}
