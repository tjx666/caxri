import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { ArgvConfig, ArgvConfigChanges } from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { atomicWriteFile, KeyedSerialQueue, parseJsonc } from '@caxri/system';
import { applyEdits, modify } from 'jsonc-parser';

const defaultArgvConfig: ArgvConfig = {
    hardwareAcceleration: true,
    remoteDebugging: true,
};

const ARGV_CONFIG_TEMPLATE = `// Caxri boot configuration. Values here are read by the Main process
// before Chromium starts, so every change only takes effect on the next launch.
{
}
`;

export function argvConfigPath(userDataPath: string): string {
    return join(userDataPath, 'config', 'argv.jsonc');
}

/**
 * Field-by-field fallback: a missing file, invalid JSONC, or a mistyped field yields the shipped defaults so a broken
 * edit can never brick the launch.
 */
function normalizeArgvConfig(parsed: unknown): ArgvConfig {
    if (typeof parsed !== 'object' || parsed === null) return { ...defaultArgvConfig };
    const record = parsed as Record<string, unknown>;
    return {
        hardwareAcceleration:
            typeof record.hardwareAcceleration === 'boolean'
                ? record.hardwareAcceleration
                : defaultArgvConfig.hardwareAcceleration,
        remoteDebugging:
            typeof record.remoteDebugging === 'boolean'
                ? record.remoteDebugging
                : defaultArgvConfig.remoteDebugging,
    };
}

function configCapacityError(): CaxriError {
    return new CaxriError(
        'CAPACITY',
        `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
    );
}

function nonRegularConfigError(): CaxriError {
    return new CaxriError('IO', 'Argv configuration source is not a regular file');
}

class ArgvConfigParseError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'ArgvConfigParseError';
    }
}

function isMissingConfigFile(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        Reflect.get(error, 'code') === 'ENOENT'
    );
}

function assertArgvConfigSourceWithinLimit(source: string): void {
    if (Buffer.byteLength(source, 'utf8') > MAX_CONFIGURATION_SOURCE_BYTES)
        throw configCapacityError();
}

interface AsyncArgvConfigReadOptions {
    /**
     * Test seam for mutating the opened file after descriptor validation and before the bounded read.
     */
    beforeRead?: () => Promise<void>;
}

/**
 * Reads the boot source from an opened descriptor so a pathname's metadata cannot authorize an unbounded read. The
 * extra byte detects growth after the initial descriptor stat while `O_NONBLOCK` makes a planted FIFO fail closed.
 */
function readArgvConfigSourceAtBoot(path: string): string {
    let descriptor: number | undefined;
    try {
        // oxlint-disable-next-line node/no-sync -- pre-ready boot must remain synchronous; see the boot reader JSDoc
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        // oxlint-disable-next-line node/no-sync -- pre-ready boot must remain synchronous; see the boot reader JSDoc
        const metadata = fstatSync(descriptor);
        if (!metadata.isFile()) throw nonRegularConfigError();
        if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) throw configCapacityError();

        const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            // oxlint-disable-next-line node/no-sync -- pre-ready boot must remain synchronous; see the boot reader JSDoc
            const count = readSync(
                descriptor,
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead,
            );
            if (count === 0) break;
            bytesRead += count;
        }
        if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) throw configCapacityError();
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        // oxlint-disable-next-line node/no-sync -- pre-ready boot must remain synchronous; see the boot reader JSDoc
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

/**
 * Reads an async configuration source from an opened descriptor with the same byte and file-type guards as boot. The
 * descriptor remains the authority through the read, preventing a stat/read pathname race from bypassing the limit.
 */
async function readArgvConfigSourceBounded(
    path: string,
    options: AsyncArgvConfigReadOptions = {},
): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) throw nonRegularConfigError();
        if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) throw configCapacityError();
        await options.beforeRead?.();

        const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            // Each read's offset depends on the byte count already read, so reads are inherently sequential.
            // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) throw configCapacityError();
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}

/**
 * Reads `argv.jsonc` before `app.whenReady()`. Deliberately synchronous: the values gate `app.commandLine.appendSwitch`
 * calls that must land before Chromium's browser process starts, which is earlier than any async boot phase this
 * process has.
 */
export function readArgvConfigAtBoot(userDataPath: string): ArgvConfig {
    try {
        // oxlint-disable-next-line node/no-sync -- must resolve before `app.whenReady()`; see JSDoc above
        const source = readArgvConfigSourceAtBoot(argvConfigPath(userDataPath));
        return normalizeArgvConfig(parseJsonc(source));
    } catch {
        return { ...defaultArgvConfig };
    }
}

async function readArgvConfigSource(
    userDataPath: string,
    options: AsyncArgvConfigReadOptions = {},
): Promise<string> {
    const source = await readArgvConfigSourceBounded(argvConfigPath(userDataPath), options);
    try {
        parseJsonc(source);
    } catch (error) {
        throw new ArgvConfigParseError(error);
    }
    return source;
}

export async function readArgvConfig(
    userDataPath: string,
    options: AsyncArgvConfigReadOptions = {},
): Promise<ArgvConfig> {
    try {
        return normalizeArgvConfig(parseJsonc(await readArgvConfigSource(userDataPath, options)));
    } catch {
        return { ...defaultArgvConfig };
    }
}

/**
 * Serializes read-modify-write cycles per config path so overlapping `argv.update` requests cannot interleave and drop
 * each other's fields; each entry is the tail of that path's write chain.
 */
const writeQueues = new KeyedSerialQueue<string>();

/**
 * Applies a partial update onto `argv.jsonc` with comment-preserving JSONC edits and an atomic unique-temp-file rename,
 * then returns the merged result. A missing or unparseable file is replaced by the commented template instead of
 * failing, while bounded-reader safety errors leave the existing target untouched.
 */
export function updateArgvConfig(
    userDataPath: string,
    changes: ArgvConfigChanges,
): Promise<ArgvConfig> {
    const path = argvConfigPath(userDataPath);
    return writeQueues.run(path, async () => {
        let source: string;
        try {
            source = await readArgvConfigSource(userDataPath);
        } catch (error) {
            if (!(error instanceof ArgvConfigParseError) && !isMissingConfigFile(error))
                throw error;
            source = ARGV_CONFIG_TEMPLATE;
        }
        for (const [key, value] of Object.entries(changes))
            source = applyEdits(
                source,
                modify(source, [key], value, {
                    formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
                }),
            );
        assertArgvConfigSourceWithinLimit(source);
        await atomicWriteFile(path, source, { durability: 'durable' });
        return normalizeArgvConfig(parseJsonc(source));
    });
}
