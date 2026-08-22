import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        expect(duplicate?.extensionId).toBe('publisher.duplicate');
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
            ({ extensionId }) => extensionId === 'publisher.missing',
        );
        expect(missing?.error.code).toBe('MANIFEST_INVALID');
    });

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
});
