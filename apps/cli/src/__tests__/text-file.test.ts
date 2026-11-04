import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { readBoundedTextFile } from '../commands/text-file';

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-text-file-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

it('reports a missing file as a validation error instead of an internal one', async () => {
    const directory = await scratch();
    await expect(
        readBoundedTextFile(join(directory, 'absent.jsonc'), 1_024, 'Configuration import'),
    ).rejects.toMatchObject({
        code: 'VALIDATION',
        message: 'Configuration import was not found',
    });
});

it('reports a symlink or a directory as the regular-file validation error', async () => {
    const directory = await scratch();
    const target = join(directory, 'target.jsonc');
    await writeFile(target, '{}');
    const link = join(directory, 'link.jsonc');
    await symlink(target, link);
    const folder = join(directory, 'folder');
    await mkdir(folder);

    await Promise.all(
        [link, folder].map((path) =>
            expect(readBoundedTextFile(path, 1_024, 'Configuration import')).rejects.toMatchObject({
                code: 'VALIDATION',
                message: 'Configuration import must be a regular file of at most 1 KiB',
            }),
        ),
    );
});

it('reads a regular file within the limit', async () => {
    const directory = await scratch();
    const path = join(directory, 'ok.jsonc');
    await writeFile(path, '{ "maxDepth": 2 }');
    await expect(readBoundedTextFile(path, 1_024, 'Configuration import')).resolves.toBe(
        '{ "maxDepth": 2 }',
    );
});
