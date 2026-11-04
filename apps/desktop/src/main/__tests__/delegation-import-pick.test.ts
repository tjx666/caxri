import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import { pickDelegationImportFile } from '../native-file-dialogs';

async function workspace() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-pick-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

function picking(filePath?: string) {
    const showOpenDialog = vi.fn().mockResolvedValue({
        canceled: filePath === undefined,
        filePaths: filePath === undefined ? [] : [filePath],
    });
    return { dialog: { showOpenDialog }, window: undefined };
}

it('returns null when the user dismisses the dialog', async () => {
    expect(await pickDelegationImportFile(picking())).toBeNull();
});

it('returns only the file name and its text, following a symlink to a regular file', async () => {
    const directory = await workspace();
    const target = join(directory, 'delegation.jsonc');
    await writeFile(target, '// text\n{"maxDepth": 2, "agents": []}');
    const link = join(directory, 'linked.jsonc');
    await symlink(target, link);
    expect(await pickDelegationImportFile(picking(link))).toEqual({
        fileName: 'linked.jsonc',
        sourceText: '// text\n{"maxDepth": 2, "agents": []}',
    });
});

it('rejects an oversized file as too_large without a path or text', async () => {
    const directory = await workspace();
    const path = join(directory, 'big.jsonc');
    await writeFile(path, 'x'.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1));
    await expect(pickDelegationImportFile(picking(path))).rejects.toMatchObject({
        code: 'VALIDATION',
        details: { issues: [{ stage: 'source', path: '', reason: 'too_large' }] },
    });
});

it('rejects a directory and a missing file with a path-free IO error', async () => {
    const directory = await workspace();
    await mkdir(join(directory, 'folder'));
    await Promise.all(
        [join(directory, 'folder'), join(directory, 'missing.jsonc')].map((path) =>
            expect(pickDelegationImportFile(picking(path))).rejects.toMatchObject({
                code: 'IO',
                message: expect.not.stringContaining(directory) as string,
            }),
        ),
    );
});
