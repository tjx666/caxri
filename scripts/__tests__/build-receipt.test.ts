import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    beginBuild,
    computeBuildSourceKey,
    recordBuild,
    REQUIRED_OUTPUTS,
    verifyBuildReceipt,
} from '../build-receipt';
import { execFileAsync } from '../exec';

const temporaryDirectories: string[] = [];

async function write(root: string, path: string, content: string): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
}

async function git(root: string, ...arguments_: string[]): Promise<void> {
    await execFileAsync('git', arguments_, { cwd: root });
}

/**
 * A committed repository with an installed lockfile and every required output, as after a real build.
 */
async function createBuiltRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-build-receipt-'));
    temporaryDirectories.push(root);
    await write(root, '.gitignore', 'node_modules/\nout/\ndist/\n.cache/\n');
    await write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    await write(root, 'node_modules/.pnpm/lock.yaml', 'lockfileVersion: 9\n');
    await write(root, 'apps/server/src/index.ts', 'export const value = 1;\n');
    await write(root, 'e2e/startup.e2e.ts', 'export {};\n');
    await write(root, 'docs/guide.md', '# Guide\n');
    await git(root, 'init', '-q');
    await git(root, 'add', '-A');
    await git(
        root,
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
    );
    await beginBuild(root);
    await Promise.all(REQUIRED_OUTPUTS.map((path) => write(root, path, `// ${path}\n`)));
    await write(root, 'out/renderer/assets/chunk-a.js', 'chunk\n');
    expect(await recordBuild(root)).toBe('recorded');
    return root;
}

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('build receipt', () => {
    it('reuses a build whose inputs and outputs are unchanged', async () => {
        const root = await createBuiltRepo();

        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({ isValid: true });
    });

    it('ignores edits under audited non-build roots and touches that keep content', async () => {
        const root = await createBuiltRepo();
        await write(root, 'e2e/startup.e2e.ts', 'export const edited = true;\n');
        await write(root, 'docs/new-note.md', '# Note\n');
        const later = new Date(Date.now() + 60_000);
        await utimes(join(root, 'apps/server/src/index.ts'), later, later);

        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({ isValid: true });
    });

    it.each([
        [
            'an edited tracked source',
            (root: string) => write(root, 'apps/server/src/index.ts', 'x\n'),
        ],
        ['a new untracked source', (root: string) => write(root, 'apps/server/src/new.ts', 'x\n')],
        ['a deleted tracked source', (root: string) => rm(join(root, 'apps/server/src/index.ts'))],
        ['an edited Markdown input', (root: string) => write(root, 'README.md', '# Notices\n')],
        ['a root environment file', (root: string) => write(root, '.env.local', 'A=1\n')],
    ])('rebuilds after %s', async (_label, mutate) => {
        const root = await createBuiltRepo();
        await mutate(root);

        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'inputs-changed',
        });
    });

    it('reuses only the same build flavor but launches any flavor of current sources', async () => {
        const root = await createBuiltRepo();
        const environment = { ...process.env, CAXRI_REACT_PROFILING: '1' };

        expect(await verifyBuildReceipt(root, { environment, purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'environment-changed',
        });
        expect(await verifyBuildReceipt(root, { environment, purpose: 'launch' })).toEqual({
            isValid: true,
        });
    });

    it.each([
        [
            'a rewritten chunk',
            (root: string) => write(root, 'out/renderer/assets/chunk-a.js', 'dev\n'),
        ],
        ['a deleted chunk', (root: string) => rm(join(root, 'out/renderer/assets/chunk-a.js'))],
        ['a missing entry bundle', (root: string) => rm(join(root, 'out/main/index.js'))],
    ])('rebuilds after %s', async (_label, mutate) => {
        const root = await createBuiltRepo();
        await mutate(root);

        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'outputs-changed',
        });
    });

    it('neither reuses nor records over an install that differs from the lockfile', async () => {
        const root = await createBuiltRepo();
        await write(root, 'pnpm-lock.yaml', 'lockfileVersion: 10\n');

        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'install-mismatch',
        });
        await beginBuild(root);
        expect(await recordBuild(root)).toBe('install-mismatch');
        // The dropped receipt must not mask the cause: rebuilding alone never clears it.
        expect(await verifyBuildReceipt(root, { purpose: 'launch' })).toEqual({
            isValid: false,
            reason: 'install-mismatch',
        });
    });

    it('drops the receipt when inputs change while the build runs', async () => {
        const root = await createBuiltRepo();
        await beginBuild(root);
        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'missing',
        });
        await write(root, 'apps/server/src/index.ts', 'export const value = 2;\n');

        expect(await recordBuild(root)).toBe('inputs-changed');
        expect(await verifyBuildReceipt(root, { purpose: 'reuse' })).toEqual({
            isValid: false,
            reason: 'missing',
        });
    });

    it('derives the same source key under Bun as under Node', async () => {
        const root = await createBuiltRepo();
        const modulePath = join(import.meta.dirname, '..', 'build-receipt.ts');
        const { stdout } = await execFileAsync(
            'bun',
            [
                '-e',
                `const { computeBuildSourceKey } = await import(${JSON.stringify(modulePath)}); console.log(await computeBuildSourceKey(${JSON.stringify(root)}));`,
            ],
            { encoding: 'utf8' },
        );

        // `check --e2e` decides under Bun while Playwright workers verify under Node.
        expect(stdout.trim()).toBe(await computeBuildSourceKey(root));
    });

    it("reads the installed Node behind Bun's `node` shim", async () => {
        const root = await createBuiltRepo();
        const modulePath = join(import.meta.dirname, '..', 'build-receipt.ts');
        // `bunx --bun` runs the Android Acceptance Playwright with a `node` that is Bun itself.
        const { stdout } = await execFileAsync(
            'bunx',
            [
                '--bun',
                'node',
                '-e',
                `const { computeBuildSourceKey } = await import(${JSON.stringify(modulePath)}); console.log(await computeBuildSourceKey(${JSON.stringify(root)}));`,
            ],
            { encoding: 'utf8' },
        );

        expect(stdout.trim()).toBe(await computeBuildSourceKey(root));
    });
});
