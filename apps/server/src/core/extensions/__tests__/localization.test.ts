import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionManifest } from '@caxri/protocol';
import { extensionManifestSchema } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManifestLocalizationError, readExtensionLocalization } from '../localization';

const manifest: ExtensionManifest = extensionManifestSchema.parse({
    name: 'publisher.fixture',
    version: '1.0.0',
    type: 'module',
    main: './extension.mjs',
    engines: { caxri: '^0.0.17' },
    caxri: { capabilities: [] },
    contributes: {
        viewsContainers: {
            secondarySidebar: [
                {
                    id: 'publisher.fixture',
                    title: '%container.title%',
                    icon: { kind: 'resource', path: 'fixture.svg' },
                },
            ],
            panel: [],
        },
        views: {
            'publisher.fixture': [
                { id: 'publisher.fixture.tree', name: '%view.name%', type: 'tree' },
            ],
        },
        commands: [
            {
                command: 'publisher.fixture.run',
                title: '%command.title%',
                description: '%command.description%',
            },
        ],
    },
});

const english = {
    'container.title': 'Fixture',
    'view.name': 'Fixture View',
    'command.title': 'Run Fixture',
    'command.description': 'Runs the fixture',
};

const temporary = { root: '' };

async function write(file: string, value: unknown): Promise<void> {
    await mkdir(join(temporary.root, file, '..'), { recursive: true });
    await writeFile(
        join(temporary.root, file),
        typeof value === 'string' ? value : JSON.stringify(value),
    );
}

beforeEach(async () => {
    // Discovery hands over a canonical root; macOS's temporary directory sits behind a `/var` symlink.
    const created = await mkdtemp(join(tmpdir(), 'caxri-extension-l10n-'));
    temporary.root = await realpath(created);
});

afterEach(async () => {
    await rm(temporary.root, { force: true, recursive: true });
});

describe('readExtensionLocalization', () => {
    it('resolves placeholders per language and falls back to the default for a missing key', async () => {
        await write('package.nls.json', english);
        await write('package.nls.zh-cn.json', {
            'container.title': '夹具',
            'view.name': '夹具视图',
        });
        await write('l10n/bundle.l10n.zh-cn.json', { 'Hello {name}': '你好 {name}' });

        const localization = await readExtensionLocalization(temporary.root, manifest);

        expect(localization.manifests.en.contributes.commands[0]).toMatchObject({
            command: 'publisher.fixture.run',
            title: 'Run Fixture',
            description: 'Runs the fixture',
        });
        const chinese = localization.manifests['zh-CN'];
        expect(chinese?.contributes.viewsContainers.secondarySidebar[0].title).toBe('夹具');
        expect(chinese?.contributes.views['publisher.fixture'][0].name).toBe('夹具视图');
        expect(chinese?.contributes.commands[0].title).toBe('Run Fixture');
        expect(localization.runtimeBundles).toEqual({
            'zh-CN': { 'Hello {name}': '你好 {name}' },
        });
        expect(localization.ignoredFiles).toEqual([]);
    });

    it('keeps the manifest text in every language when the extension ships no localization', async () => {
        const plain = {
            ...manifest,
            contributes: { ...manifest.contributes, commands: [{ command: 'a.b', title: 'Run' }] },
        };
        const localization = await readExtensionLocalization(temporary.root, plain);
        expect(Object.keys(localization.manifests)).toEqual(['en']);
        expect(localization.manifests.en.contributes.commands[0].title).toBe('Run');
        expect(localization.runtimeBundles).toEqual({});
    });

    it('drops an invalid translation to English instead of rejecting the extension', async () => {
        await write('package.nls.json', english);
        // Valid as a bundle, but longer than a command title may be.
        await write('package.nls.zh-cn.json', { 'command.title': '长'.repeat(201) });
        await write('l10n/bundle.l10n.zh-cn.json', '{ not json');

        const localization = await readExtensionLocalization(temporary.root, manifest);

        expect(localization.manifests['zh-CN']).toBeUndefined();
        expect(localization.runtimeBundles).toEqual({});
        expect(localization.ignoredFiles).toEqual(
            expect.arrayContaining([
                { file: 'package.nls.zh-cn.json', reason: 'manifest-invalid' },
                { file: 'l10n/bundle.l10n.zh-cn.json', reason: 'invalid' },
            ]),
        );
    });

    it('refuses a localization file linked from outside the extension root', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'caxri-extension-l10n-outside-'));
        try {
            await writeFile(join(outside, 'nls.json'), JSON.stringify({ 'view.name': '外部' }));
            await write('package.nls.json', english);
            await symlink(
                join(outside, 'nls.json'),
                join(temporary.root, 'package.nls.zh-cn.json'),
            );

            const localization = await readExtensionLocalization(temporary.root, manifest);

            expect(localization.manifests['zh-CN']).toBeUndefined();
            expect(localization.ignoredFiles).toEqual([
                { file: 'package.nls.zh-cn.json', reason: 'escapes-root' },
            ]);
        } finally {
            await rm(outside, { force: true, recursive: true });
        }
    });

    it('rejects the extension when its default text does not resolve to a valid manifest', async () => {
        await write('package.nls.json', { ...english, 'command.title': 'x'.repeat(201) });
        await expect(readExtensionLocalization(temporary.root, manifest)).rejects.toBeInstanceOf(
            ManifestLocalizationError,
        );
    });
});
