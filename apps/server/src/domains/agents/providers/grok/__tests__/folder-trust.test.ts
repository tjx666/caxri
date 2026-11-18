import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { grantGrokFolderTrust, grokTrustStorePath } from '../folder-trust';

const NOW = () => new Date('2026-01-02T03:04:05Z');
const NOW_SECONDS = 1_767_323_045;

async function fixture(options: { grokHome?: boolean; store?: string } = {}) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-grok-trust-'));
    const home = await realpath(created);
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const environment = { homeDirectory: home, variables: {} };
    const path = grokTrustStorePath(environment);
    if (options.grokHome !== false) await mkdir(join(home, '.grok'));
    if (options.store !== undefined) await writeFile(path, options.store);
    const workspace = join(home, 'worktrees', 'feature');
    await mkdir(workspace, { recursive: true });
    return { environment, home, path, workspace };
}

function table(key: string, isTrusted = true, decidedAt = NOW_SECONDS): string {
    return `[folders."${key}"]\ntrusted = ${isTrusted}\ndecided_at = ${decidedAt}\n`;
}

describe('grantGrokFolderTrust', () => {
    it('appends the folder after the existing tables without rewriting them', async () => {
        const existing = `${table('/projects/app', true, 1)}\n${table('/projects/other', false, 2)}`;
        const { environment, path, workspace } = await fixture({ store: existing });

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('granted');

        expect(await readFile(path, 'utf8')).toBe(`${existing}\n${table(workspace)}`);
    });

    it('does not mistake a sibling folder that shares a prefix for the folder', async () => {
        const { environment, path, workspace } = await fixture();
        const sibling = table(`${workspace}-other`, false, 1);
        await writeFile(path, sibling);

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('granted');

        expect(await readFile(path, 'utf8')).toBe(`${sibling}\n${table(workspace)}`);
    });

    it('creates the store when Grok has not recorded any folder yet', async () => {
        const { environment, path, workspace } = await fixture();

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('granted');

        expect(await readFile(path, 'utf8')).toBe(table(workspace));
    });

    it('records the canonical path of a folder reached through a symlink', async () => {
        const { environment, home, path, workspace } = await fixture();
        const link = join(home, 'link');
        await symlink(workspace, link);

        await grantGrokFolderTrust(environment, link, NOW);

        expect(await readFile(path, 'utf8')).toBe(table(workspace));
    });

    it('leaves an already trusted folder untouched', async () => {
        const { environment, workspace } = await fixture();
        const original = table(workspace, true, 1);
        await writeFile(grokTrustStorePath(environment), original);

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe(
            'already_trusted',
        );
        expect(await readFile(grokTrustStorePath(environment), 'utf8')).toBe(original);
    });

    it('never overrides a folder the user declined', async () => {
        const { environment, workspace } = await fixture();
        const original = table(workspace, false, 1);
        await writeFile(grokTrustStorePath(environment), original);

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('declined');
        expect(await readFile(grokTrustStorePath(environment), 'utf8')).toBe(original);
    });

    it.each([
        ['a literal-quoted header', (key: string) => `[folders.'${key}']\ntrusted = true\n`],
        ['an inline table', (key: string) => `[folders]\n"${key}" = { trusted = true }\n`],
        ['a table without trusted', (key: string) => `[folders."${key}"]\ndecided_at = 1\n`],
    ])('skips a store that mentions the folder as %s', async (_case, store) => {
        const { environment, workspace } = await fixture();
        const original = store(workspace);
        await writeFile(grokTrustStorePath(environment), original);

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('skipped');
        expect(await readFile(grokTrustStorePath(environment), 'utf8')).toBe(original);
    });

    it('skips when Grok Build has no home directory', async () => {
        const { environment, path, workspace } = await fixture({ grokHome: false });

        await expect(grantGrokFolderTrust(environment, workspace, NOW)).resolves.toBe('skipped');
        await expect(readFile(path, 'utf8')).rejects.toThrow();
    });

    it('skips the home directory, which Grok never records', async () => {
        const { environment, home, path } = await fixture();

        await expect(grantGrokFolderTrust(environment, home, NOW)).resolves.toBe('skipped');
        await expect(readFile(path, 'utf8')).rejects.toThrow();
    });

    it('honors GROK_HOME', async () => {
        const { home, workspace } = await fixture({ grokHome: false });
        await mkdir(join(home, 'custom-grok'));
        const environment = { homeDirectory: home, variables: { GROK_HOME: 'custom-grok' } };

        await grantGrokFolderTrust(environment, workspace, NOW);

        expect(await readFile(join(home, 'custom-grok', 'trusted_folders.toml'), 'utf8')).toBe(
            table(workspace),
        );
    });
});
