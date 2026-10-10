import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSourceReadError, readBoundedConfigSource } from '../source';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

async function configDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-config-source-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function rejection(path: string): Promise<unknown> {
    try {
        await readBoundedConfigSource(path);
    } catch (error) {
        return error;
    }
    throw new Error('expected the configuration source read to be rejected');
}

describe('readBoundedConfigSource', () => {
    it('reads a regular configuration file', async () => {
        const path = join(await configDirectory(), 'settings.jsonc');
        await writeFile(path, '{ "theme": "dark" }', 'utf8');

        await expect(readBoundedConfigSource(path)).resolves.toBe('{ "theme": "dark" }');
    });

    /**
     * A plain read-only open of a FIFO blocks until a writer appears, so a FIFO planted at `settings.jsonc` used to
     * hang the configuration load. It now fails at once as a rejected source with a stable revision, which the polling
     * path uses to report the same rejected file only once.
     */
    it.skipIf(process.platform === 'win32')(
        'refuses a FIFO at the configuration path without waiting for a writer',
        async () => {
            const path = join(await configDirectory(), 'settings.jsonc');
            await execFileAsync('mkfifo', [path]);

            const first = await rejection(path);
            const second = await rejection(path);

            expect(first).toBeInstanceOf(ConfigSourceReadError);
            expect(first).toMatchObject({ message: 'Configuration source is not a regular file' });
            expect((first as ConfigSourceReadError).revision).toMatch(/^\d+:\d+:0:/u);
            expect((second as ConfigSourceReadError).revision).toBe(
                (first as ConfigSourceReadError).revision,
            );
        },
        2_000,
    );

    it('rejects an oversized source with its revision and keeps a missing file a filesystem fault', async () => {
        const directory = await configDirectory();
        const oversized = join(directory, 'keybindings.jsonc');
        await writeFile(oversized, ' '.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1), 'utf8');

        const error = await rejection(oversized);
        expect(error).toBeInstanceOf(ConfigSourceReadError);
        expect(error).toMatchObject({
            message: `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
        });
        expect((error as ConfigSourceReadError).revision).toContain(
            `:${MAX_CONFIGURATION_SOURCE_BYTES + 1}:`,
        );

        const missing = await rejection(join(directory, 'theme.json'));
        expect(missing).not.toBeInstanceOf(ConfigSourceReadError);
        expect(missing).toMatchObject({ code: 'ENOENT' });
    });
});
