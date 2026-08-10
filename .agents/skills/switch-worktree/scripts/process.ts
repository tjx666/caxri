import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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

export async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(command, args, {
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
    args: string[],
    options: SpawnOptions & { cwd: string; stdoutToStderr?: boolean },
): Promise<number> {
    const { stdoutToStderr = false, ...spawnOptions } = options;
    const child = spawn(command, args, {
        ...spawnOptions,
        stdio: stdoutToStderr ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    if (stdoutToStderr) child.stdout?.pipe(process.stderr);
    return await new Promise<number>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => {
            if (signal) rejectExit(new CommandError(`${command} exited with ${signal}`));
            else resolveExit(code ?? 1);
        });
    });
}

/** Hash start time plus command so PID reuse is detectable without persisting command arguments. */
export async function getProcessIdentity(pid: number): Promise<string | undefined> {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
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
