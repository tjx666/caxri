import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from '@caxri/system';

import { assertNativeDialogAuthorization } from './native-dialog-authorization';

export interface NativeAxResult {
    code?: string;
    elapsedMs: number;
    matchCount: number;
    message?: string;
    ok: boolean;
    ownerPid?: number;
    role?: string;
    selectedPath?: string;
    title?: string;
}

class NativeAxError extends Error {
    constructor(public readonly result: NativeAxResult) {
        super(
            result.message
                ? `Native Accessibility helper failed (${result.code ?? 'unknown'}): ${result.message}`
                : `Native Accessibility helper failed (${result.code ?? 'unknown'})`,
        );
        this.name = 'NativeAxError';
    }
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const NATIVE_AX_SOURCE_PATH = resolve(
    dirname(SCRIPT_PATH),
    '..',
    'native',
    'ax-helper.swift',
);
const DEFAULT_CACHE_ROOT = join(homedir(), '.cache', 'caxri', 'acceptance', 'native-ax');
const COMPILE_TIMEOUT_MS = 30_000;

function outputText(value: unknown): string {
    if (typeof value === 'string') return value;
    return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

export function nativeAxCacheKey(input: {
    architecture: string;
    platform: string;
    source: string;
    toolchain: string;
}): string {
    return createHash('sha256')
        .update(input.source)
        .update('\0')
        .update(input.toolchain)
        .update('\0')
        .update(input.platform)
        .update('\0')
        .update(input.architecture)
        .digest('hex');
}

export function parseNativeAxResult(stdout: string): NativeAxResult {
    const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length !== 1) {
        throw new Error('Native Accessibility helper must return exactly one JSON line');
    }
    let value: unknown;
    try {
        value = JSON.parse(lines[0]);
    } catch (error: unknown) {
        throw new Error(`Invalid Native Accessibility JSON: ${lines[0]}`, { cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Native Accessibility response must be an object');
    }
    const response = value as Partial<NativeAxResult>;
    if (
        typeof response.ok !== 'boolean' ||
        !Number.isSafeInteger(response.elapsedMs) ||
        (response.elapsedMs ?? -1) < 0 ||
        !Number.isSafeInteger(response.matchCount) ||
        (response.matchCount ?? -1) < 0 ||
        (response.ownerPid !== undefined && !Number.isSafeInteger(response.ownerPid)) ||
        (response.code !== undefined && typeof response.code !== 'string') ||
        (response.message !== undefined && typeof response.message !== 'string') ||
        (response.role !== undefined && typeof response.role !== 'string') ||
        (response.selectedPath !== undefined && typeof response.selectedPath !== 'string') ||
        (response.title !== undefined && typeof response.title !== 'string')
    ) {
        throw new Error('Native Accessibility response has an invalid shape');
    }
    return response as NativeAxResult;
}

export function nativeAxArguments(
    command: string,
    options: {
        button: string;
        path?: string;
        pid: number;
        timeoutMs: number;
        title?: string;
    },
): string[] {
    return [
        command,
        '--pid',
        String(options.pid),
        '--button',
        options.button,
        ...(options.title ? ['--title', options.title] : []),
        ...(options.path ? ['--path', options.path] : []),
        '--timeout-ms',
        String(options.timeoutMs),
    ];
}

async function resolveNativeAxBinary(cacheRoot = DEFAULT_CACHE_ROOT): Promise<string> {
    if (process.platform !== 'darwin') {
        throw new Error('Native Accessibility is supported only on macOS');
    }
    const [{ stdout: rawToolchain }, source] = await Promise.all([
        execFileAsync('xcrun', ['swiftc', '--version'], { timeout: COMPILE_TIMEOUT_MS }),
        readFile(NATIVE_AX_SOURCE_PATH, 'utf8'),
    ]);
    const key = nativeAxCacheKey({
        architecture: process.arch,
        platform: process.platform,
        source,
        toolchain: outputText(rawToolchain),
    });
    const cacheDirectory = join(cacheRoot, key);
    const binaryPath = join(cacheDirectory, 'ax-helper');
    try {
        await access(binaryPath, constants.X_OK);
        return binaryPath;
    } catch {
        // A source/toolchain-specific cache miss is expected once per machine.
    }

    await mkdir(cacheDirectory, { recursive: true });
    const temporaryPath = join(cacheDirectory, `.ax-helper-${process.pid}-${randomUUID()}`);
    try {
        await execFileAsync('xcrun', ['swiftc', '-O', NATIVE_AX_SOURCE_PATH, '-o', temporaryPath], {
            timeout: COMPILE_TIMEOUT_MS,
        });
        await rename(temporaryPath, binaryPath);
    } finally {
        try {
            await unlink(temporaryPath);
        } catch {
            // The successful atomic rename consumes the temporary path.
        }
    }
    await access(binaryPath, constants.X_OK);
    return binaryPath;
}

export async function runNativeAx(
    command: string,
    options: {
        button: string;
        path?: string;
        pid: number;
        timeoutMs: number;
        title?: string;
    },
): Promise<NativeAxResult> {
    assertNativeDialogAuthorization();
    const binaryPath = await resolveNativeAxBinary();
    const arguments_ = nativeAxArguments(command, options);
    let stdout = '';
    try {
        const result = await execFileAsync(binaryPath, arguments_, {
            timeout: options.timeoutMs + 3_000,
        });
        stdout = outputText(result.stdout);
    } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'stdout' in error) {
            stdout = outputText(error.stdout);
        }
        if (!stdout) {
            throw new Error('Native Accessibility helper exited without a structured response', {
                cause: error,
            });
        }
    }
    const response = parseNativeAxResult(stdout);
    if (!response.ok) throw new NativeAxError(response);
    return response;
}
