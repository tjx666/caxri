import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { antigravitySettingsPath, grantAntigravityFolderTrust } from '../folder-trust';

async function fixture(settings?: string) {
    const home = await mkdtemp(join(tmpdir(), 'caxri-antigravity-trust-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const environment = { homeDirectory: home, variables: {} };
    const path = antigravitySettingsPath(environment);
    if (settings !== undefined) {
        await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
        await writeFile(path, settings);
    }
    return { environment, home, path };
}

describe('grantAntigravityFolderTrust', () => {
    it('appends the folder and keeps unknown keys in their order', async () => {
        const { environment, path } = await fixture(
            '{"model":"m","trustedWorkspaces":["/a"],"extra":{"x":1}}\n',
        );

        await expect(grantAntigravityFolderTrust(environment, '/projects/app')).resolves.toBe(
            'granted',
        );

        const text = await readFile(path, 'utf8');
        expect(Object.keys(JSON.parse(text) as object)).toEqual([
            'model',
            'trustedWorkspaces',
            'extra',
        ]);
        expect(JSON.parse(text)).toMatchObject({ trustedWorkspaces: ['/a', '/projects/app'] });
        expect(text.endsWith('}\n')).toBe(true);
    });

    it('adds the list to settings that have none yet', async () => {
        const { environment, path } = await fixture('{"model":"m"}');

        await grantAntigravityFolderTrust(environment, '/projects/app');

        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
            model: 'm',
            trustedWorkspaces: ['/projects/app'],
        });
    });

    it('leaves an already trusted folder untouched', async () => {
        const original = '{"trustedWorkspaces":["/projects/app"]}';
        const { environment, path } = await fixture(original);

        await expect(grantAntigravityFolderTrust(environment, '/projects/app')).resolves.toBe(
            'already_trusted',
        );
        expect(await readFile(path, 'utf8')).toBe(original);
    });

    it('trusts both the real path and the linked path of a symlinked folder', async () => {
        const { environment, home, path } = await fixture('{"trustedWorkspaces":[]}');
        const real = join(home, 'real');
        const link = join(home, 'link');
        await mkdir(real);
        await symlink(real, link);

        await grantAntigravityFolderTrust(environment, link);

        const trusted = (
            JSON.parse(await readFile(path, 'utf8')) as { trustedWorkspaces: string[] }
        ).trustedWorkspaces;
        expect(trusted).toHaveLength(2);
        expect(trusted.at(-1)).toBe(link);
    });

    it.each([
        ['a missing file', undefined],
        ['unparsable JSON', '{nope'],
        ['a non-object top level', '[]'],
        ['a trustedWorkspaces that is not a string list', '{"trustedWorkspaces":"/a"}'],
    ])('skips %s without creating or rewriting anything', async (_case, settings) => {
        const { environment, path } = await fixture(settings);

        await expect(grantAntigravityFolderTrust(environment, '/projects/app')).resolves.toBe(
            'skipped',
        );
        if (settings === undefined) await expect(readFile(path, 'utf8')).rejects.toThrow();
        else expect(await readFile(path, 'utf8')).toBe(settings);
    });
});
