import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface CommandCaptureOptions {
    cwd?: string;
    killGraceMs?: number;
    maxOutputBytes?: number;
    timeoutMs?: number;
}

/**
 * Captures a subprocess without allowing time, output, or raw stderr to escape into the ledger.
 * A bounded byte-count summary is retained in errors so failures remain useful without persisting
 * arbitrary external output.
 */
export function captureCommand(
    command: string,
    arguments_: string[],
    options: CommandCaptureOptions = {},
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (timeoutMs <= 0 || maxOutputBytes <= 0 || killGraceMs < 0) {
        throw new Error('Command capture limits must be positive');
    }

    return new Promise((resolve, reject) => {
        const child = spawn(command, arguments_, {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let termination: 'output' | 'timeout' | null = null;
        let forceKill: NodeJS.Timeout | undefined;
        let isSettled = false;

        const evidence = (): string => `stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes}`;
        const terminate = (reason: 'output' | 'timeout'): void => {
            if (termination) return;
            termination = reason;
            child.kill('SIGTERM');
            forceKill = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
            forceKill.unref();
        };
        const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
        timeout.unref();
        const finish = (error?: Error): void => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            if (forceKill) clearTimeout(forceKill);
            if (error) reject(error);
            else resolve(Buffer.concat(stdout).toString('utf8').trim());
        };

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes + stderrBytes > maxOutputBytes) terminate('output');
            else stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.byteLength;
            if (stdoutBytes + stderrBytes > maxOutputBytes) terminate('output');
        });
        child.once('error', (error) =>
            finish(new Error(`Failed to start ${command}: ${error.message}`)),
        );
        child.once('close', (code) => {
            if (termination === 'timeout') {
                finish(new Error(`${command} timed out after ${timeoutMs}ms (${evidence()})`));
            } else if (termination === 'output') {
                finish(
                    new Error(`${command} output exceeded ${maxOutputBytes} bytes (${evidence()})`),
                );
            } else if (code === 0) finish();
            else finish(new Error(`${command} exited ${String(code)} (${evidence()})`));
        });
    });
}
