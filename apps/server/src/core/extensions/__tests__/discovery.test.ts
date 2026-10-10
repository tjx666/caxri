import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { extensionIdSchema } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverExtensions } from '../discovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function writeExtension(
    root: string,
    directory: string,
    overrides: Record<string, unknown> = {},
): Promise<void> {
    const extensionRoot = join(root, directory);
    await mkdir(join(extensionRoot, 'dist'), { recursive: true });
    await writeFile(join(extensionRoot, 'dist/extension.js'), 'export function activate() {}');
    await writeFile(
        join(extensionRoot, 'package.json'),
        JSON.stringify({
            name: `publisher.${directory}`,
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {},
            ...overrides,
        }),
    );
}

describe('discoverExtensions', () => {
    it('discovers a canonical ESM entry without evaluating it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-discovery-'));
        temporaryDirectories.push(root);
        await writeExtension(root, 'valid');

        const result = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.rejected).toEqual([]);
        expect(result.extensions).toEqual([
            expect.objectContaining({ extensionId: 'publisher.valid', source: 'bundled' }),
        ]);
    });

    it('keeps the first root authoritative when an installed extension duplicates its id', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-bundled-'));
        const installedRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-installed-'));
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(bundledRoot, 'first', { name: 'publisher.duplicate' });
        await writeExtension(installedRoot, 'second', { name: 'publisher.duplicate' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([
            expect.objectContaining({ extensionId: 'publisher.duplicate', source: 'bundled' }),
        ]);
        const duplicate = result.rejected.find(({ error }) => error.code === 'DUPLICATE_ID');
        expect(duplicate?.extensionId).not.toBe('publisher.duplicate');
        expect(extensionIdSchema.safeParse(duplicate?.extensionId).success).toBe(true);
    });

    it('does not let an installed extension replace a rejected bundled id', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-bundled-rejected-'));
        const installedRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-installed-shadow-'));
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(bundledRoot, 'broken', {
            name: 'publisher.reserved',
            engines: { caxri: '^1.0.0' },
        });
        await writeExtension(installedRoot, 'shadow', { name: 'publisher.reserved' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([]);
        expect(result.rejected.map(({ error }) => error.code)).toEqual([
            'ENGINE_INCOMPATIBLE',
            'DUPLICATE_ID',
        ]);
    });

    it('rejects a missing entry without aborting discovery of sibling extensions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-missing-entry-'));
        temporaryDirectories.push(root);
        await writeExtension(root, 'missing');
        await writeExtension(root, 'valid');
        await rm(join(root, 'missing/dist/extension.js'));

        const result = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions.map(({ extensionId }) => extensionId)).toEqual([
            'publisher.valid',
        ]);
        const missing = result.rejected.find(
            ({ error }) => error.message === 'Extension entry is missing or inaccessible',
        );
        expect(missing?.error.code).toBe('MANIFEST_INVALID');
        expect(extensionIdSchema.safeParse(missing?.extensionId).success).toBe(true);
    });

    /**
     * A plain read-only open of a FIFO waits for a writer, so a FIFO planted as one installed extension's
     * `package.json` used to stall discovery of every extension. It is now one rejected extension.
     */
    it.skipIf(process.platform === 'win32')(
        'rejects a FIFO manifest at once without hiding sibling extensions',
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'caxri-extension-fifo-manifest-'));
            temporaryDirectories.push(root);
            await mkdir(join(root, 'planted'));
            await execFileAsync('mkfifo', [join(root, 'planted', 'package.json')]);
            await writeExtension(root, 'valid');

            const result = await discoverExtensions({
                roots: [root],
                appVersion: '0.0.17',
                includeTestOnly: false,
            });

            expect(result.extensions.map(({ extensionId }) => extensionId)).toEqual([
                'publisher.valid',
            ]);
            expect(result.rejected).toEqual([
                expect.objectContaining({
                    error: {
                        code: 'MANIFEST_INVALID',
                        message: 'Extension package.json is not a regular file',
                    },
                }),
            ]);
        },
        2_000,
    );

    it('rejects CommonJS and incompatible engines before executing extension code', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-invalid-'));
        temporaryDirectories.push(root);
        await writeExtension(root, 'commonjs', { main: './dist/extension.cjs', type: 'commonjs' });
        await writeExtension(root, 'future', { engines: { caxri: '^1.0.0' } });

        const result = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(
            result.rejected
                .map(({ error }) => error.code)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['COMMONJS_ENTRY_UNSUPPORTED', 'ENGINE_INCOMPATIBLE']);
    });

    it('keeps test-only fixtures out of ordinary product launches', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-test-only-'));
        temporaryDirectories.push(root);
        await writeExtension(root, 'fixture', {
            caxri: { capabilities: [], testOnly: true },
        });

        const hidden = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });
        const visible = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: true,
        });

        expect(hidden.extensions).toEqual([]);
        expect(visible.extensions).toHaveLength(1);
    });

    it('rejects unsupported manifest fields without hiding a healthy sibling', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-unsupported-manifest-'));
        temporaryDirectories.push(root);
        await writeExtension(root, 'activation', { activationEvents: ['*'] });
        await writeExtension(root, 'condition', {
            contributes: {
                views: {
                    'publisher.condition': [
                        {
                            id: 'publisher.condition.tree',
                            name: 'Condition',
                            type: 'tree',
                            when: 'never',
                        },
                    ],
                },
            },
        });
        await writeExtension(root, 'healthy');

        const result = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions.map(({ extensionId }) => extensionId)).toEqual([
            'publisher.healthy',
        ]);
        expect(result.rejected).toHaveLength(2);
        expect(result.rejected.map(({ error }) => error.code)).toEqual([
            'MANIFEST_INVALID',
            'MANIFEST_INVALID',
        ]);
        expect(result.rejected.map(({ error }) => error.message).join('\n')).toMatch(
            /activationEvents|when/u,
        );
    });

    it('assigns malformed JSON a bounded catalog-safe identity without hiding siblings', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-extension-malformed-json-'));
        temporaryDirectories.push(root);
        const malformedDirectory = `NOT AN EXTENSION ${'x'.repeat(180)}`;
        await mkdir(join(root, malformedDirectory));
        await writeFile(join(root, malformedDirectory, 'package.json'), '{');
        await writeExtension(root, 'healthy');

        const result = await discoverExtensions({
            roots: [root],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions.map(({ extensionId }) => extensionId)).toEqual([
            'publisher.healthy',
        ]);
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].error.code).toBe('MANIFEST_INVALID');
        expect(extensionIdSchema.safeParse(result.rejected[0].extensionId).success).toBe(true);
    });

    it('does not let a malformed installed manifest reserve a healthy sibling identity', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-clean-bundled-'));
        const installedRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-malformed-installed-'));
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(installedRoot, 'a-malformed', {
            name: 'publisher.valid',
            type: 'commonjs',
        });
        await writeExtension(installedRoot, 'z-valid', { name: 'publisher.valid' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([
            expect.objectContaining({ extensionId: 'publisher.valid', source: 'installed' }),
        ]);
        expect(result.rejected[0].error.code).toBe('COMMONJS_ENTRY_UNSUPPORTED');
        expect(result.rejected[0].extensionId).not.toBe('publisher.valid');
        expect(extensionIdSchema.safeParse(result.rejected[0].extensionId).success).toBe(true);
    });

    it('does not let a missing installed entry reserve a healthy sibling identity', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-clean-bundled-'));
        const installedRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-missing-installed-'));
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(installedRoot, 'a-missing', { name: 'publisher.valid' });
        await rm(join(installedRoot, 'a-missing/dist/extension.js'));
        await writeExtension(installedRoot, 'z-valid', { name: 'publisher.valid' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([
            expect.objectContaining({ extensionId: 'publisher.valid', source: 'installed' }),
        ]);
        expect(result.rejected[0].error.code).toBe('MANIFEST_INVALID');
        expect(result.rejected[0].extensionId).not.toBe('publisher.valid');
    });

    it('does not let an incompatible installed engine reserve a healthy sibling identity', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-clean-bundled-'));
        const installedRoot = await mkdtemp(
            join(tmpdir(), 'caxri-extension-incompatible-installed-'),
        );
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(installedRoot, 'a-incompatible', {
            name: 'publisher.valid',
            engines: { caxri: '^1.0.0' },
        });
        await writeExtension(installedRoot, 'z-valid', { name: 'publisher.valid' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([
            expect.objectContaining({ extensionId: 'publisher.valid', source: 'installed' }),
        ]);
        expect(result.rejected[0].error.code).toBe('ENGINE_INCOMPATIBLE');
        expect(result.rejected[0].extensionId).not.toBe('publisher.valid');
    });

    it('keeps a malformed bundled identity authoritative over installed extensions', async () => {
        const bundledRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-malformed-bundled-'));
        const installedRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-shadow-installed-'));
        temporaryDirectories.push(bundledRoot, installedRoot);
        await writeExtension(bundledRoot, 'malformed', {
            name: 'publisher.reserved',
            type: 'commonjs',
        });
        await writeExtension(installedRoot, 'shadow', { name: 'publisher.reserved' });

        const result = await discoverExtensions({
            roots: [bundledRoot, installedRoot],
            appVersion: '0.0.17',
            includeTestOnly: false,
        });

        expect(result.extensions).toEqual([]);
        expect(result.rejected.map(({ error }) => error.code)).toEqual([
            'COMMONJS_ENTRY_UNSUPPORTED',
            'DUPLICATE_ID',
        ]);
    });

    it.each([
        { range: '^1.2.3', appVersion: '1.2.0', accepted: false },
        { range: '^1.2.3', appVersion: '1.9.0', accepted: true },
        { range: '^1.2.3', appVersion: '2.0.0', accepted: false },
        { range: '^0.2.3', appVersion: '0.2.9', accepted: true },
        { range: '^0.2.3', appVersion: '0.3.0', accepted: false },
        { range: '^0.0.3', appVersion: '0.0.3', accepted: true },
        { range: '^0.0.3', appVersion: '0.0.4', accepted: false },
        { range: '^1.2.3', appVersion: '1.3.0-beta.1', accepted: false },
        { range: 'not-a-range', appVersion: '1.2.3', accepted: false },
    ])(
        'applies standard SemVer range $range to $appVersion',
        async ({ range, appVersion, accepted }) => {
            const root = await mkdtemp(join(tmpdir(), 'caxri-extension-semver-'));
            temporaryDirectories.push(root);
            await writeExtension(root, 'semver', { engines: { caxri: range } });

            const result = await discoverExtensions({
                roots: [root],
                appVersion,
                includeTestOnly: false,
            });

            expect(result.extensions).toHaveLength(accepted ? 1 : 0);
            expect(result.rejected).toHaveLength(accepted ? 0 : 1);
        },
    );
});
