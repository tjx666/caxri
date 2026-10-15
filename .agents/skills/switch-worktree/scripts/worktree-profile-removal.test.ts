import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    finishProfileRemoval,
    prepareProfileRemoval,
    PRESERVED_PROFILE_MARKER,
} from './worktree-profile-removal';

const temporaryDirectories: string[] = [];
const identity = '4364e9dc-fb1b-4262-93f7-73f10eac2298';

async function fixture(): Promise<{
    profile: string;
    profileRoot: string;
    stateDirectory: string;
}> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-profile-removal-'));
    temporaryDirectories.push(temporary);
    const stateDirectory = join(temporary, 'state');
    const profileRoot = join(stateDirectory, 'profiles');
    const profile = join(profileRoot, identity);
    await mkdir(profile, { recursive: true });
    return { profile, profileRoot, stateDirectory };
}

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { force: true, recursive: true })));
});

describe('worktree profile removal safety', () => {
    it('refuses deletion after the profile root is replaced by a symlink', async () => {
        const { profile, profileRoot, stateDirectory } = await fixture();
        const removal = await prepareProfileRemoval(stateDirectory, identity, false, '/worktree');
        const externalProfileRoot = join(stateDirectory, '..', 'external-profiles');
        await rename(profileRoot, externalProfileRoot);
        await writeFile(join(externalProfileRoot, identity, 'keep.txt'), 'safe\n', 'utf8');
        await symlink(externalProfileRoot, profileRoot);

        await expect(finishProfileRemoval(removal)).rejects.toThrow(
            'Refusing to clean from non-directory isolated profile',
        );
        expect(await readFile(join(profile, 'keep.txt'), 'utf8')).toBe('safe\n');
    });

    it('refuses a preservation marker symlink without overwriting its target', async () => {
        const { profile, stateDirectory } = await fixture();
        const externalTarget = join(stateDirectory, '..', 'preserved-marker-target.txt');
        await writeFile(externalTarget, 'safe\n', 'utf8');
        await symlink(externalTarget, join(profile, PRESERVED_PROFILE_MARKER));

        await expect(
            prepareProfileRemoval(stateDirectory, identity, true, '/worktree'),
        ).rejects.toThrow('Refusing to overwrite unsafe preserved profile marker');
        expect(await readFile(externalTarget, 'utf8')).toBe('safe\n');
    });
});
