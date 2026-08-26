import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { satisfies } from 'semver';
import { describe, expect, it } from 'vitest';

interface ReleaseManifest {
    engines?: { caxri: string };
    version: string;
}

const workspaceRoot = process.cwd();

async function readPackageManifest(...segments: string[]): Promise<ReleaseManifest> {
    const manifest = await readFile(join(workspaceRoot, ...segments), 'utf8');
    return JSON.parse(manifest) as ReleaseManifest;
}

describe('workspace package manifests', () => {
    it('keeps the public extension API version aligned with the Desktop release', async () => {
        const [appManifestText, apiManifestText] = await Promise.all([
            readFile(join(workspaceRoot, 'package.json'), 'utf8'),
            readFile(join(workspaceRoot, 'packages/extension-api/package.json'), 'utf8'),
        ]);
        const appManifest = JSON.parse(appManifestText) as { version: string };
        const apiManifest = JSON.parse(apiManifestText) as { version: string };

        expect(apiManifest.version).toBe(appManifest.version);
    });

    it('exposes caxri source types before build artifacts exist', async () => {
        const manifestPath = join(workspaceRoot, 'packages/extension-api/package.json');
        const manifestText = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText) as {
            exports: { '.': { import: string; types: string } };
        };

        expect(manifest.exports['.']).toEqual({
            import: './dist/index.js',
            types: './src/index.ts',
        });
    });

    it.each(['fixture', 'git', 'status'])(
        'models the %s extension as an isolated workspace package',
        async (name) => {
            const extensionRoot = join(workspaceRoot, 'extensions', name);
            const appManifestPath = join(workspaceRoot, 'package.json');
            const appManifestText = await readFile(appManifestPath, 'utf8');
            const appManifest = JSON.parse(appManifestText) as { version: string };
            const manifestText = await readFile(join(extensionRoot, 'package.json'), 'utf8');
            const manifest = JSON.parse(manifestText) as {
                devDependencies?: Record<string, string>;
                engines?: { caxri?: string };
                scripts?: Record<string, string>;
                version?: string;
            };

            expect(manifest.devDependencies).toEqual({
                '@caxri/protocol': 'workspace:*',
                'caxri': 'workspace:*',
            });
            expect(manifest.version).toBe(appManifest.version);
            expect(manifest.engines?.caxri).toBe(`^${appManifest.version}`);
            expect(manifest.scripts).toEqual({
                build: `bun run --cwd ../.. scripts/build-extension.ts --extension-root extensions/${name}`,
                typecheck: 'tsc --noEmit -p tsconfig.json',
            });
            await expect(access(join(extensionRoot, 'tsconfig.json'))).resolves.toBeUndefined();
        },
    );

    it('keeps the public API and bundled extensions compatible with the Desktop release', async () => {
        const desktopManifest = await readPackageManifest('package.json');
        const apiManifest = await readPackageManifest('packages', 'extension-api', 'package.json');
        const extensionNames = ['fixture', 'git', 'status'];
        const extensionManifests = await Promise.all(
            extensionNames.map((name) => readPackageManifest('extensions', name, 'package.json')),
        );

        expect(apiManifest.version).toBe(desktopManifest.version);
        for (const [index, name] of extensionNames.entries()) {
            const manifest = extensionManifests[index];

            expect(manifest.version, `${name} extension version`).toBe(desktopManifest.version);
            expect(
                satisfies(desktopManifest.version, manifest.engines?.caxri ?? ''),
                `${name} extension engines.caxri`,
            ).toBe(true);
        }
    });

    it('keeps Files in Workbench Core instead of an extension workspace', async () => {
        const filesExtensionRoot = join(workspaceRoot, 'extensions', 'files');
        await expect(access(filesExtensionRoot)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('keeps Git context actions declared but out of the argument-less Command Palette', async () => {
        const manifestPath = join(workspaceRoot, 'extensions/git/package.json');
        const manifestText = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText) as {
            contributes: { commands: Array<{ command: string; palette?: boolean }> };
        };
        const commands = new Map(
            manifest.contributes.commands.map((command) => [command.command, command]),
        );

        for (const id of [
            'caxri.git.sync',
            'caxri.git.discardAll',
            'caxri.git.discard',
            'caxri.git.openChanges',
            'caxri.git.openSubmodule',
            'caxri.git.history',
        ])
            expect(commands.get(id)?.palette).toBe(false);
    });

    it('keeps extension typecheck and build orchestration package-local', async () => {
        const manifestText = await readFile(join(process.cwd(), 'package.json'), 'utf8');
        const manifest = JSON.parse(manifestText) as {
            knip: {
                workspaces: Record<string, { ignoreDependencies?: string[] }>;
            };
            scripts: Record<string, string>;
        };
        const buildScript = await readFile(
            join(process.cwd(), 'scripts', 'build-extension.ts'),
            'utf8',
        );

        expect(manifest.scripts['typecheck:extensions']).toBe(
            "pnpm --recursive --filter './extensions/*' run typecheck",
        );
        expect(manifest.scripts['build:extensions']).toBe(
            "pnpm --recursive --filter './extensions/*' run build",
        );
        for (const name of ['fixture', 'git', 'status'])
            expect(manifest.knip.workspaces[`extensions/${name}`]?.ignoreDependencies).toEqual([
                '@caxri/protocol',
            ]);
        const sharedRoot = join(process.cwd(), 'extensions');
        const legacyConfig = access(join(sharedRoot, 'tsconfig.json'));
        const baseConfig = access(join(sharedRoot, 'tsconfig.base.json'));

        await expect(legacyConfig).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(baseConfig).resolves.toBeUndefined();
        expect(buildScript).toContain("from '@caxri/protocol'");
        expect(buildScript).toContain('assertProductExtensionBundleContract');
        expect(buildScript).toContain('manifest.caxri.testOnly');
    });

    it('keeps the production package free of test-only extension resources', async () => {
        const manifestText = await readFile(join(process.cwd(), 'package.json'), 'utf8');
        const manifest = JSON.parse(manifestText) as {
            build: { extraResources: Array<{ from: string }> };
            scripts: Record<string, string>;
        };

        const extraResourceSources = manifest.build.extraResources.map(({ from }) => from);

        expect(extraResourceSources.filter((source) => source.startsWith('extensions/'))).toEqual(
            [],
        );
        expect(extraResourceSources).toContain('apps/server/dist/server');
        expect(manifest.scripts['package:e2e']).toBe(
            'bun run build && bun run scripts/package-extension-test-app.ts',
        );
    });
});
