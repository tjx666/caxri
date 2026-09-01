import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
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
});
