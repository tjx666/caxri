import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { removeDelegationFiles } from '../storage';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-storage-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const profile = join(directory, 'profile');
    const outside = join(directory, 'outside');
    await mkdir(profile);
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'Synthetic user file');
    return { profile, outside };
}

describe('Delegation file reclamation', () => {
    it('unlinks a replaced task-directory symlink without following it', async () => {
        const { profile, outside } = await fixture();
        const root = join(profile, 'delegations');
        await mkdir(root, { mode: 0o700 });
        const id = randomUUID();
        await symlink(outside, join(root, id));
        await removeDelegationFiles(profile, [id]);
        await expect(access(join(root, id))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Synthetic user file');
    });

    it('rejects a replaced storage root and path-like identifiers before deleting anything', async () => {
        const { profile, outside } = await fixture();
        await symlink(outside, join(profile, 'delegations'));
        await expect(removeDelegationFiles(profile, [randomUUID()])).rejects.toThrow(
            /private directory/u,
        );
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Synthetic user file');
        await rm(join(profile, 'delegations'));
        await mkdir(join(profile, 'delegations'), { mode: 0o700 });
        await expect(removeDelegationFiles(profile, ['../../outside'])).rejects.toThrow(
            /generated identifiers/u,
        );
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Synthetic user file');
    });
});
