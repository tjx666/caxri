import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { CaxriError } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { readPrivateJsonFile } from '../private-json-store';

const directories: string[] = [];
const messages = {
    malformed: 'malformed',
    notPrivate: 'not private',
    oversized: 'oversized',
    wrongOwner: 'wrong owner',
};

afterEach(async () => {
    const pendingDirectories = [...directories];
    directories.length = 0;
    await Promise.all(pendingDirectories.map((directory) => rm(directory, { recursive: true })));
});

describe('readPrivateJsonFile', () => {
    it('opens the final path without following a symlink', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-private-json-'));
        directories.push(directory);
        const target = join(directory, 'target.json');
        const path = join(directory, 'store.json');
        await writeFile(target, '{"value":true}\n', { mode: 0o600 });
        await symlink(target, path);

        await expect(
            readPrivateJsonFile({ maxBytes: 1_024, messages, path }),
        ).rejects.toMatchObject({
            code: 'PATH_DENIED',
            message: 'not private',
        } satisfies Partial<CaxriError>);
    });

    /**
     * A plain read-only open of a FIFO waits for a writer, so a FIFO planted at a private store path used to block the
     * Server Core read indefinitely. It is now refused at once as a non-private store.
     */
    it.skipIf(process.platform === 'win32')(
        'refuses a FIFO at the store path without waiting for a writer',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-private-json-fifo-'));
            directories.push(directory);
            const path = join(directory, 'store.json');
            await execFileAsync('mkfifo', ['-m', '600', path]);

            await expect(
                readPrivateJsonFile({ maxBytes: 1_024, messages, path }),
            ).rejects.toMatchObject({
                code: 'PATH_DENIED',
                message: 'not private',
            } satisfies Partial<CaxriError>);
        },
        2_000,
    );

    it('reads an owner-only store and keeps its own codes for shared or oversized files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-private-json-policy-'));
        directories.push(directory);
        const path = join(directory, 'store.json');
        await writeFile(path, '{"value":true}\n', { mode: 0o600 });
        await expect(readPrivateJsonFile({ maxBytes: 1_024, messages, path })).resolves.toEqual({
            value: true,
        });

        await expect(readPrivateJsonFile({ maxBytes: 4, messages, path })).rejects.toMatchObject({
            code: 'VALIDATION',
            message: 'oversized',
        } satisfies Partial<CaxriError>);

        const shared = join(directory, 'shared.json');
        await writeFile(shared, '{}', { mode: 0o644 });
        await expect(
            readPrivateJsonFile({ maxBytes: 1_024, messages, path: shared }),
        ).rejects.toMatchObject({
            code: 'PATH_DENIED',
            message: 'not private',
        } satisfies Partial<CaxriError>);

        const malformed = join(directory, 'malformed.json');
        await writeFile(malformed, '{', { mode: 0o600 });
        await expect(
            readPrivateJsonFile({ maxBytes: 1_024, messages, path: malformed }),
        ).rejects.toMatchObject({
            code: 'VALIDATION',
            message: 'malformed',
        } satisfies Partial<CaxriError>);
    });
});
