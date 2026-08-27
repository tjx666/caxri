import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ArgvConfig, ArgvConfigChanges } from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { applyEdits, modify } from 'jsonc-parser';

const defaultArgvConfig: ArgvConfig = {
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
        remoteDebugging:
            typeof record.remoteDebugging === 'boolean'
                ? record.remoteDebugging
                : defaultArgvConfig.remoteDebugging,
    };
}

/**
 * Reads `argv.jsonc` before `app.whenReady()`. Deliberately synchronous: the values gate `app.commandLine.appendSwitch`
 * calls that must land before Chromium's browser process starts, which is earlier than any async boot phase this
 * process has.
 */
export function readArgvConfigAtBoot(userDataPath: string): ArgvConfig {
    try {
        // oxlint-disable-next-line node/no-sync -- must resolve before `app.whenReady()`; see JSDoc above
        const source = readFileSync(argvConfigPath(userDataPath), 'utf8');
        return normalizeArgvConfig(parseJsonc(source));
    } catch {
        return { ...defaultArgvConfig };
    }
}

async function readArgvConfigSource(userDataPath: string): Promise<string> {
    const source = await readFile(argvConfigPath(userDataPath), 'utf8');
    parseJsonc(source);
    return source;
}

export async function readArgvConfig(userDataPath: string): Promise<ArgvConfig> {
    try {
        return normalizeArgvConfig(parseJsonc(await readArgvConfigSource(userDataPath)));
    } catch {
        return { ...defaultArgvConfig };
    }
}

/**
 * Serializes read-modify-write cycles per config path so overlapping `argv.update` requests cannot interleave and drop
 * each other's fields; each entry is the tail of that path's write chain.
 */
const writeQueues = new Map<string, Promise<unknown>>();

async function enqueueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(path) ?? Promise.resolve();
    const next = (async () => {
        // A failed predecessor must not poison the chain; its rejection already reached its caller.
        try {
            await previous;
        } catch {
            // ignored: only ordering matters here
        }
        return task();
    })();
    writeQueues.set(path, next);
    return next;
}

/**
 * Applies a partial update onto `argv.jsonc` with comment-preserving JSONC edits and an atomic unique-temp-file rename,
 * then returns the merged result. An unreadable or unparseable file is replaced by the commented template instead of
 * failing, matching the boot reader's fallback posture.
 */
export function updateArgvConfig(
    userDataPath: string,
    changes: ArgvConfigChanges,
): Promise<ArgvConfig> {
    const path = argvConfigPath(userDataPath);
    return enqueueWrite(path, async () => {
        let source: string;
        try {
            source = await readArgvConfigSource(userDataPath);
        } catch {
            source = ARGV_CONFIG_TEMPLATE;
        }
        for (const [key, value] of Object.entries(changes))
            source = applyEdits(
                source,
                modify(source, [key], value, {
                    formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
                }),
            );
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600 });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
        return normalizeArgvConfig(parseJsonc(source));
    });
}
