import { Buffer } from 'node:buffer';
import { constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    argvConfigPath,
    readArgvConfig,
    readArgvConfigAtBoot,
    updateArgvConfig,
} from '../argv-config';

function createUserDataDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'caxri-argv-'));
}

function writeArgvConfig(userDataPath: string, source: string): void {
    mkdirSync(join(userDataPath, 'config'), { recursive: true });
    writeFileSync(argvConfigPath(userDataPath), source, 'utf8');
}

function boundarySource(isRemoteDebugging: boolean): string {
    const prefix = `{
  // keep me
  "remoteDebugging": ${isRemoteDebugging},
`;
    const suffix = '}\n';
    const padding = MAX_CONFIGURATION_SOURCE_BYTES - Buffer.byteLength(prefix + suffix, 'utf8');
    return `${prefix}${' '.repeat(padding)}${suffix}`;
}

async function completeWithin<T>(promise: Promise<T>, timeoutMs = 750): Promise<T> {
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () => reject(new Error(`argv config operation did not settle within ${timeoutMs}ms`)),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeout!);
    }
}

async function unblockFifoReader(path: string): Promise<void> {
    try {
        const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
    } catch {
        // The nonblocking reader has already rejected and closed the FIFO.
    }
}

function bootReaderScript(): string {
    const modulePath = join(process.cwd(), 'apps/desktop/src/main/argv-config.ts');
    return `import { readArgvConfigAtBoot } from ${JSON.stringify(modulePath)};
console.log(JSON.stringify(readArgvConfigAtBoot(process.argv.at(-1))));`;
}

describe('readArgvConfigAtBoot', () => {
    it('returns defaults when the file does not exist', () => {
        expect(readArgvConfigAtBoot(createUserDataDirectory())).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('reads a commented JSONC file', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(
            userDataPath,
            '{\n  // disabled for a demo\n  "remoteDebugging": false,\n}',
        );
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('falls back to defaults on invalid JSONC', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ not valid');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('falls back per-field on mistyped values', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": "off" }');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('ignores unknown fields', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": false, "future": 1 }');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('accepts a JSONC source exactly at the shared byte ceiling', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, boundarySource(false));

        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
        await expect(readArgvConfig(userDataPath)).resolves.toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('falls back promptly for a non-regular source', async () => {
        const userDataPath = createUserDataDirectory();
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        mkdirSync(argvConfigPath(userDataPath));

        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
        await expect(completeWithin(readArgvConfig(userDataPath))).resolves.toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('falls back promptly for a FIFO without a writer', async () => {
        const userDataPath = createUserDataDirectory();
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        const path = argvConfigPath(userDataPath);
        await execFileAsync('mkfifo', [path]);

        try {
            await expect(completeWithin(readArgvConfig(userDataPath))).resolves.toEqual({
                hardwareAcceleration: true,
                remoteDebugging: true,
            });
        } finally {
            await unblockFifoReader(path);
        }
    });

    it('keeps the pre-ready boot reader from hanging on a FIFO', async () => {
        const userDataPath = createUserDataDirectory();
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        const path = argvConfigPath(userDataPath);
        await execFileAsync('mkfifo', [path]);

        try {
            const result = await execFileAsync(
                'bun',
                ['--eval', bootReaderScript(), '--', userDataPath],
                { cwd: process.cwd(), timeout: 3_000 },
            );
            expect(result.stdout.trim()).toBe(
                JSON.stringify({ hardwareAcceleration: true, remoteDebugging: true }),
            );
        } finally {
            await unblockFifoReader(path);
        }
    });
});

describe('readArgvConfig', () => {
    it('matches the boot reader for a present file', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": false }');
        await expect(readArgvConfig(userDataPath)).resolves.toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('returns defaults when the file does not exist', async () => {
        await expect(readArgvConfig(createUserDataDirectory())).resolves.toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });
});

describe('updateArgvConfig', () => {
    it('creates the file from the commented template on first write', async () => {
        const userDataPath = createUserDataDirectory();
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: false });
        expect(result).toEqual({ hardwareAcceleration: true, remoteDebugging: false });
        const source = readFileSync(argvConfigPath(userDataPath), 'utf8');
        expect(source).toContain('// Caxri boot configuration');
        expect(source).toContain('"remoteDebugging": false');
    });

    it('preserves operator comments on subsequent writes', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{\n  // keep me\n  "remoteDebugging": true\n}');
        await updateArgvConfig(userDataPath, { remoteDebugging: false });
        const source = readFileSync(argvConfigPath(userDataPath), 'utf8');
        expect(source).toContain('// keep me');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('preserves comments while updating a source at the byte ceiling', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, boundarySource(false));

        await expect(updateArgvConfig(userDataPath, { remoteDebugging: true })).resolves.toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
        const source = readFileSync(argvConfigPath(userDataPath), 'utf8');
        expect(source).toContain('// keep me');
        expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(
            MAX_CONFIGURATION_SOURCE_BYTES,
        );
    });

    it('rejects an update that would cross the byte ceiling without replacing the source', async () => {
        const userDataPath = createUserDataDirectory();
        const path = argvConfigPath(userDataPath);
        const source = boundarySource(true);
        writeArgvConfig(userDataPath, source);

        await expect(
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
        ).rejects.toMatchObject({
            code: 'CAPACITY',
        });
        expect(readFileSync(path, 'utf8')).toBe(source);
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('does not parse or overwrite a source that grows beyond the byte ceiling', async () => {
        const userDataPath = createUserDataDirectory();
        const path = argvConfigPath(userDataPath);
        const source = boundarySource(false);
        writeArgvConfig(userDataPath, source);

        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
        await expect(
            readArgvConfig(userDataPath, {
                beforeRead: () => appendFile(path, ' '),
            }),
        ).resolves.toEqual({ hardwareAcceleration: true, remoteDebugging: true });
        const oversizedSource = readFileSync(path, 'utf8');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
        await expect(
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
        ).rejects.toMatchObject({
            code: 'CAPACITY',
        });
        expect(readFileSync(path, 'utf8')).toBe(oversizedSource);
    });

    it('does not overwrite a Unix socket when opening the source fails', async () => {
        const userDataPath = createUserDataDirectory();
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        const path = argvConfigPath(userDataPath);
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(path, resolve);
        });

        try {
            await expect(
                updateArgvConfig(userDataPath, { remoteDebugging: false }),
            ).rejects.toThrow();
            expect(lstatSync(path).isSocket()).toBe(true);
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    });

    it('does not overwrite a FIFO during an update', async () => {
        const userDataPath = createUserDataDirectory();
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        const path = argvConfigPath(userDataPath);
        await execFileAsync('mkfifo', [path]);

        try {
            await expect(
                completeWithin(updateArgvConfig(userDataPath, { remoteDebugging: false })),
            ).rejects.toMatchObject({ code: 'IO' });
        } finally {
            await unblockFifoReader(path);
        }
    });

    it('replaces an unparseable file with the template instead of failing', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ broken');
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: false });
        expect(result).toEqual({ hardwareAcceleration: true, remoteDebugging: false });
    });

    it('round-trips back to enabled', async () => {
        const userDataPath = createUserDataDirectory();
        await updateArgvConfig(userDataPath, { remoteDebugging: false });
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: true });
        expect(result).toEqual({ hardwareAcceleration: true, remoteDebugging: true });
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('serializes overlapping writes without corrupting the file', async () => {
        const userDataPath = createUserDataDirectory();
        const results = await Promise.all([
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
            updateArgvConfig(userDataPath, { remoteDebugging: true }),
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
        ]);
        expect(results.at(-1)).toEqual({ hardwareAcceleration: true, remoteDebugging: false });
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: false,
        });
    });

    it('applies an empty change set without corrupting the file', async () => {
        const userDataPath = createUserDataDirectory();
        await updateArgvConfig(userDataPath, {});
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({
            hardwareAcceleration: true,
            remoteDebugging: true,
        });
    });

    it('persists hardware acceleration independently from remote debugging', async () => {
        const userDataPath = createUserDataDirectory();
        const result = await updateArgvConfig(userDataPath, { hardwareAcceleration: false });

        expect(result).toEqual({ hardwareAcceleration: false, remoteDebugging: true });
        expect(readArgvConfigAtBoot(userDataPath)).toEqual(result);
    });
});
