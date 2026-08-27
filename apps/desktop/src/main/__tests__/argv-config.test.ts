import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('readArgvConfigAtBoot', () => {
    it('returns defaults when the file does not exist', () => {
        expect(readArgvConfigAtBoot(createUserDataDirectory())).toEqual({ remoteDebugging: true });
    });

    it('reads a commented JSONC file', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(
            userDataPath,
            '{\n  // disabled for a demo\n  "remoteDebugging": false,\n}',
        );
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: false });
    });

    it('falls back to defaults on invalid JSONC', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ not valid');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: true });
    });

    it('falls back per-field on mistyped values', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": "off" }');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: true });
    });

    it('ignores unknown fields', () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": false, "future": 1 }');
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: false });
    });
});

describe('readArgvConfig', () => {
    it('matches the boot reader for a present file', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ "remoteDebugging": false }');
        await expect(readArgvConfig(userDataPath)).resolves.toEqual({ remoteDebugging: false });
    });

    it('returns defaults when the file does not exist', async () => {
        await expect(readArgvConfig(createUserDataDirectory())).resolves.toEqual({
            remoteDebugging: true,
        });
    });
});

describe('updateArgvConfig', () => {
    it('creates the file from the commented template on first write', async () => {
        const userDataPath = createUserDataDirectory();
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: false });
        expect(result).toEqual({ remoteDebugging: false });
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
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: false });
    });

    it('replaces an unparseable file with the template instead of failing', async () => {
        const userDataPath = createUserDataDirectory();
        writeArgvConfig(userDataPath, '{ broken');
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: false });
        expect(result).toEqual({ remoteDebugging: false });
    });

    it('round-trips back to enabled', async () => {
        const userDataPath = createUserDataDirectory();
        await updateArgvConfig(userDataPath, { remoteDebugging: false });
        const result = await updateArgvConfig(userDataPath, { remoteDebugging: true });
        expect(result).toEqual({ remoteDebugging: true });
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: true });
    });

    it('serializes overlapping writes without corrupting the file', async () => {
        const userDataPath = createUserDataDirectory();
        const results = await Promise.all([
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
            updateArgvConfig(userDataPath, { remoteDebugging: true }),
            updateArgvConfig(userDataPath, { remoteDebugging: false }),
        ]);
        expect(results.at(-1)).toEqual({ remoteDebugging: false });
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: false });
    });

    it('applies an empty change set without corrupting the file', async () => {
        const userDataPath = createUserDataDirectory();
        await updateArgvConfig(userDataPath, {});
        expect(readArgvConfigAtBoot(userDataPath)).toEqual({ remoteDebugging: true });
    });
});
