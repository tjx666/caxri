import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changedPathsBetween } from '../rebind-delta';

const gitRoot = { path: '' };

async function git(...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd: gitRoot.path });
    return stdout.trim();
}

async function commit(message: string): Promise<string> {
    await git('add', '-A');
    await git('commit', '--no-gpg-sign', '-m', message);
    return git('rev-parse', 'HEAD');
}

describe('changedPathsBetween', () => {
    beforeEach(async () => {
        gitRoot.path = await mkdtemp(join(tmpdir(), 'caxri-rebind-delta-'));
        await git('init', '--initial-branch=main');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'Test');
        await mkdir(join(gitRoot.path, 'apps', 'desktop'), { recursive: true });
        await writeFile(join(gitRoot.path, 'apps', 'desktop', 'ship.ts'), 'export const a = 1;');
    });

    afterEach(async () => {
        await rm(gitRoot.path, { force: true, recursive: true });
    });

    it('reports the source path when a product file is moved into .agents/', async () => {
        const before = await commit('seed');
        await mkdir(join(gitRoot.path, '.agents', 'skills'), { recursive: true });
        await git('mv', 'apps/desktop/ship.ts', '.agents/skills/ship.ts');
        const after = await commit('move product code out of apps');

        /**
         * With git's rename detection on, this delta is a single `.agents/skills/ship.ts` entry, and the rebind gate
         * would accept a head that deleted a product source file.
         */
        await expect(changedPathsBetween(before, after, gitRoot.path)).resolves.toEqual(
            expect.arrayContaining(['.agents/skills/ship.ts', 'apps/desktop/ship.ts']),
        );
    });

    it('reports only the skill path when the delta really is non-product', async () => {
        const before = await commit('seed');
        await mkdir(join(gitRoot.path, '.agents', 'skills'), { recursive: true });
        await writeFile(join(gitRoot.path, '.agents', 'skills', 'tool.ts'), 'export const b = 2;');
        const after = await commit('add a skill script');

        await expect(changedPathsBetween(before, after, gitRoot.path)).resolves.toEqual([
            '.agents/skills/tool.ts',
        ]);
    });

    it('fails closed on a revision that git would read as an option', async () => {
        const after = await commit('seed');

        /**
         * `git diff --output=<file>..<sha>` exits 0 with empty stdout, and an empty delta is exactly what the gate
         * reads as "nothing product-facing changed".
         */
        await expect(
            changedPathsBetween(`--output=${join(gitRoot.path, 'pwn.txt')}`, after, gitRoot.path),
        ).rejects.toThrow('to a commit in this repository');
    });

    it('fails closed on a revision that does not exist', async () => {
        const after = await commit('seed');

        await expect(changedPathsBetween('0'.repeat(40), after, gitRoot.path)).rejects.toThrow(
            'to a commit in this repository',
        );
    });
});
