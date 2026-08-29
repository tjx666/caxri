#!/usr/bin/env bun

import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import process from 'node:process';

interface ValidationChildRequest {
    arguments: string[];
    environment: Record<string, string>;
    executable: string;
    worktreePath: string;
}

type ValidationChildMessage =
    | { message: string; type: 'spawn_error' }
    | { code: number | null; signal: NodeJS.Signals | null; type: 'result' };

const control = createWriteStream('', { autoClose: false, fd: 3 });

function sendControl(message: ValidationChildMessage, afterWrite?: () => void): void {
    control.write(`${JSON.stringify(message)}\n`, afterWrite);
}

function parseRequest(source: string): ValidationChildRequest {
    const value: unknown = JSON.parse(source);
    if (typeof value !== 'object' || value === null) throw new Error('Request must be an object');
    const request = value as Partial<ValidationChildRequest>;
    if (typeof request.executable !== 'string' || !request.executable.trim()) {
        throw new Error('Executable is required');
    }
    if (
        !Array.isArray(request.arguments) ||
        request.arguments.some((value) => typeof value !== 'string')
    ) {
        throw new Error('Arguments must be strings');
    }
    if (typeof request.worktreePath !== 'string' || !request.worktreePath) {
        throw new Error('Worktree path is required');
    }
    const environment: unknown = Reflect.get(value, 'environment');
    if (
        typeof environment !== 'object' ||
        environment === null ||
        Object.values(environment).some((value) => typeof value !== 'string')
    ) {
        throw new Error('Environment values must be strings');
    }
    return { ...request, environment } as ValidationChildRequest;
}

const lifecycle = { isCommandStarted: false, requestBuffer: '' };

/**
 * Keep the process-group leader alive while its command drains a forwarded signal. Recovery can then revalidate this
 * stable leader identity before signaling the group, and the child close callback remains the normal exit owner.
 */
const keepSupervisorAlive = (): undefined => undefined;
process.on('SIGINT', keepSupervisorAlive);
process.on('SIGTERM', keepSupervisorAlive);

/**
 * The parent leaves stdin open for the whole validation. If it is killed before registration, this inert supervisor
 * exits without launching the command; after launch, closing stdin terminates the entire detached process group instead
 * of leaving validation descendants behind.
 */
process.stdin.on('end', () => {
    if (!lifecycle.isCommandStarted) process.exit(1);
    if (process.platform === 'win32') process.kill(process.pid, 'SIGTERM');
    else process.kill(-process.pid, 'SIGTERM');
});

process.stdin.on('data', (chunk: Buffer) => {
    if (lifecycle.isCommandStarted) return;
    lifecycle.requestBuffer += chunk.toString();
    const newline = lifecycle.requestBuffer.indexOf('\n');
    if (newline === -1) return;
    lifecycle.isCommandStarted = true;
    let request: ValidationChildRequest;
    try {
        request = parseRequest(lifecycle.requestBuffer.slice(0, newline));
    } catch (error: unknown) {
        sendControl(
            {
                message: error instanceof Error ? error.message : String(error),
                type: 'spawn_error',
            },
            () => process.exit(1),
        );
        return;
    }

    const child = spawn(request.executable, request.arguments, {
        cwd: request.worktreePath,
        env: request.environment,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', (error) => {
        sendControl({ message: error.message, type: 'spawn_error' });
    });
    child.once('close', (code, signal) => {
        sendControl({ code, signal, type: 'result' }, () => process.exit(code ?? 1));
    });
});
