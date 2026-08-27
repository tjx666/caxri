import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyRuntimeExports } from './verify-exports';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true })));
});

async function fixture(importSpecifier: string): Promise<URL> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-runtime-export-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'dependency.js'), 'export const value = true;\n', 'utf8');
    await writeFile(
        join(root, 'index.js'),
        `export { value } from '${importSpecifier}';\n`,
        'utf8',
    );
    return pathToFileURL(join(root, 'index.js'));
}

describe('Agent skill runtime exports', () => {
    it('loads emitted ESM with resolvable relative specifiers', async () => {
        await expect(
            verifyRuntimeExports([await fixture('./dependency.js')]),
        ).resolves.toBeUndefined();
    });

    it('rejects extensionless emitted ESM before it reaches a Server artifact', async () => {
        await expect(verifyRuntimeExports([await fixture('./dependency')])).rejects.toThrow(
            'ERR_MODULE_NOT_FOUND',
        );
    });
});
