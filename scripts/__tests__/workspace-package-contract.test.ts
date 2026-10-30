import { execFile } from 'node:child_process';
import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { parse as parseJsonc } from 'jsonc-parser';
import { satisfies } from 'semver';
import { describe, expect, it } from 'vitest';

import { discoverReleaseManifestPaths } from '../../.agents/skills/release/scripts/prepare-release';
import serverConfigText from '../../apps/server/tsconfig.json?raw';
import extensionsConfigText from '../../extensions/tsconfig.base.json?raw';
import nodeConfigText from '../../tsconfig.node.json?raw';

interface ReleaseManifest {
    engines?: { caxri: string };
    version: string;
}

const workspaceRoot = process.cwd();
const execFileAsync = promisify(execFile);

interface RuntimeExportConditions {
    bun: string;
    import: string;
    types: string;
}

interface RuntimePackageManifest {
    exports: Record<string, RuntimeExportConditions>;
    name: string;
}

async function readPackageManifest(...segments: string[]): Promise<ReleaseManifest> {
    const manifest = await readFile(join(workspaceRoot, ...segments), 'utf8');
    return JSON.parse(manifest) as ReleaseManifest;
}

describe('workspace package manifests', () => {
    it('keeps product-coupled workspace versions aligned with the Desktop release', async () => {
        const productManifest = await readPackageManifest('package.json');
        const coupledManifests = await Promise.all(
            [
                ['apps', 'cli', 'package.json'],
                ['apps', 'desktop', 'package.json'],
                ['apps', 'server', 'package.json'],
                ['packages', 'agent-skills', 'package.json'],
                ['packages', 'client', 'package.json'],
            ].map((segments) => readPackageManifest(...segments)),
        );

        for (const manifest of coupledManifests)
            expect(manifest.version).toBe(productManifest.version);
    });

    it('keeps the public extension API version aligned with the Desktop release', async () => {
        const [appManifestText, apiManifestText] = await Promise.all([
            readFile(join(workspaceRoot, 'package.json'), 'utf8'),
            readFile(join(workspaceRoot, 'packages/extension-api/package.json'), 'utf8'),
        ]);
        const appManifest = JSON.parse(appManifestText) as { version: string };
        const apiManifest = JSON.parse(apiManifestText) as { version: string };

        expect(apiManifest.version).toBe(appManifest.version);
    });

    it('keeps product and public package license metadata aligned', async () => {
        const [rootManifestText, apiManifestText, projectLicense, apiLicense] = await Promise.all([
            readFile(join(workspaceRoot, 'package.json'), 'utf8'),
            readFile(join(workspaceRoot, 'packages/extension-api/package.json'), 'utf8'),
            readFile(join(workspaceRoot, 'LICENSE'), 'utf8'),
            readFile(join(workspaceRoot, 'packages/extension-api/LICENSE'), 'utf8'),
        ]);
        const rootManifest = JSON.parse(rootManifestText) as {
            build: { files: string[] };
            license: string;
        };
        const apiManifest = JSON.parse(apiManifestText) as { license: string };

        expect(rootManifest.license).toBe('SEE LICENSE IN LICENSE');
        expect(apiManifest.license).toBe(rootManifest.license);
        expect(rootManifest.build.files).toContain('LICENSE');
        expect(apiLicense).toBe(projectLicense);
    });

    it('exposes the public caxri types from its published build', async () => {
        const manifestPath = join(workspaceRoot, 'packages/extension-api/package.json');
        const manifestText = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText) as {
            exports: { '.': { import: string; types: string } };
        };

        expect(manifest.exports['.']).toEqual({
            import: './dist/index.js',
            types: './dist/index.d.ts',
        });
    });

    it('resolves workspace caxri typechecks from current source', async () => {
        // TypeScript reads these as JSONC, so a comment in one must not break this contract. The `?raw` imports let
        // changed-file discovery select this test when a tsconfig changes.
        const mappings = [
            {
                config: nodeConfigText,
                configPath: 'tsconfig.node.json',
                sourcePath: './packages/extension-api/src/index.ts',
            },
            {
                config: extensionsConfigText,
                configPath: 'extensions/tsconfig.base.json',
                sourcePath: '../packages/extension-api/src/index.ts',
            },
        ];

        await Promise.all(
            mappings.map(({ configPath, sourcePath }) =>
                access(join(workspaceRoot, dirname(configPath), sourcePath)),
            ),
        );
        for (const { config, sourcePath } of mappings) {
            const parsed = parseJsonc(config) as {
                compilerOptions: { paths: Record<string, string[]> };
            };
            expect(parsed.compilerOptions.paths.caxri).toEqual([sourcePath]);
        }

        const serverConfig = parseJsonc(serverConfigText) as {
            exclude: string[];
            include: string[];
        };
        expect(serverConfig.include).toContain('../../packages/extension-api/src/**/*.ts');
        expect(serverConfig.exclude).toContain('../../packages/extension-api/src/**/*.test.ts');
    });

    it('ships a caxri tarball that an external TypeScript project can consume', async () => {
        const temporaryRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-api-package-'));
        try {
            const apiRoot = join(workspaceRoot, 'packages/extension-api');
            const packageRoot = join(temporaryRoot, 'package-source');
            const tarballRoot = join(temporaryRoot, 'tarballs');
            const consumerRoot = join(temporaryRoot, 'consumer');
            await Promise.all([
                mkdir(packageRoot, { recursive: true }),
                mkdir(tarballRoot, { recursive: true }),
                mkdir(consumerRoot, { recursive: true }),
            ]);
            await Promise.all([
                copyFile(join(apiRoot, 'package.json'), join(packageRoot, 'package.json')),
                copyFile(join(apiRoot, 'LICENSE'), join(packageRoot, 'LICENSE')),
            ]);
            await execFileAsync(
                join(workspaceRoot, 'node_modules/.bin/tsc'),
                [
                    '-p',
                    join(apiRoot, 'tsconfig.build.json'),
                    '--outDir',
                    join(packageRoot, 'dist'),
                    '--rootDir',
                    join(apiRoot, 'src'),
                ],
                { cwd: workspaceRoot },
            );
            await execFileAsync('pnpm', ['pack', '--pack-destination', tarballRoot], {
                cwd: packageRoot,
            });
            const tarballs = (await readdir(tarballRoot)).filter((name) => name.endsWith('.tgz'));
            expect(tarballs).toHaveLength(1);

            await writeFile(
                join(consumerRoot, 'package.json'),
                '{"private":true,"type":"module"}\n',
            );
            await execFileAsync('pnpm', ['add', `caxri@file:${join(tarballRoot, tarballs[0])}`], {
                cwd: consumerRoot,
            });
            const installedPackageRoot = join(consumerRoot, 'node_modules/caxri');

            await expect(
                access(join(installedPackageRoot, 'dist/index.d.ts')),
            ).resolves.toBeUndefined();
            await expect(access(join(installedPackageRoot, 'LICENSE'))).resolves.toBeUndefined();
            await expect(
                access(join(installedPackageRoot, 'dist/__tests__/api.test.d.ts')),
            ).rejects.toMatchObject({ code: 'ENOENT' });

            await writeFile(
                join(consumerRoot, 'index.ts'),
                "import type { DisposableLike } from 'caxri';\nconst disposable: DisposableLike = { dispose() {} };\ndisposable.dispose();\n",
            );
            await execFileAsync(
                join(workspaceRoot, 'node_modules/.bin/tsc'),
                [
                    '--noEmit',
                    '--module',
                    'NodeNext',
                    '--moduleResolution',
                    'NodeNext',
                    '--strict',
                    '--target',
                    'ES2023',
                    'index.ts',
                ],
                { cwd: consumerRoot },
            );
            const { stdout: runtimeOutput } = await execFileAsync(
                'node',
                [
                    '--input-type=module',
                    '--eval',
                    "const resolved = import.meta.resolve('caxri'); const api = await import('caxri'); process.stdout.write(JSON.stringify({ disposable: typeof api.Disposable, resolved }));",
                ],
                { cwd: consumerRoot },
            );
            const runtime = JSON.parse(runtimeOutput) as { disposable: string; resolved: string };
            expect(runtime.disposable).toBe('function');
            expect(runtime.resolved.endsWith('/dist/index.js')).toBe(true);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    }, 30_000);

    it('runs private workspace packages from source in Bun while preserving Node build exports', async () => {
        const manifestPaths = [
            'packages/agent-skills/package.json',
            'packages/client/package.json',
            'packages/protocol/package.json',
            'packages/system/package.json',
            'packages/utils/package.json',
        ];
        const manifests = await Promise.all(
            manifestPaths.map(async (path) => {
                const contents = await readFile(join(workspaceRoot, path), 'utf8');
                return JSON.parse(contents) as RuntimePackageManifest;
            }),
        );
        const exports = manifests.flatMap((manifest) =>
            Object.entries(manifest.exports).map(([subpath, conditions]) => ({
                conditions,
                specifier: subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
            })),
        );

        for (const { conditions } of exports) {
            expect(conditions.bun).toBe(conditions.types);
            expect(conditions.bun).toMatch(/^\.\/src\/.+\.ts$/u);
            expect(conditions.import).toMatch(/^\.\/dist\/.+\.js$/u);
        }

        const resolutionGroups = [
            {
                cwd: workspaceRoot,
                exports: exports.filter(
                    ({ specifier }) => !specifier.startsWith('@caxri/agent-skills'),
                ),
            },
            {
                cwd: join(workspaceRoot, 'apps/cli'),
                exports: exports.filter(({ specifier }) =>
                    specifier.startsWith('@caxri/agent-skills'),
                ),
            },
        ];
        const resolutionResults = await Promise.all(
            resolutionGroups.map(async (group) => {
                const specifiers = group.exports.map(({ specifier }) => specifier);
                const resolver = `process.stdout.write(JSON.stringify(${JSON.stringify(specifiers)}.map((specifier) => import.meta.resolve(specifier))))`;
                const bunRuntimeProbe = `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier))); ${resolver}`;
                const [{ stdout: bunOutput }, { stdout: nodeOutput }] = await Promise.all([
                    execFileAsync('bun', ['--no-env-file', '--eval', bunRuntimeProbe], {
                        cwd: group.cwd,
                    }),
                    execFileAsync('node', ['--input-type=module', '--eval', resolver], {
                        cwd: group.cwd,
                    }),
                ]);
                return {
                    bunPaths: JSON.parse(bunOutput) as string[],
                    exports: group.exports,
                    nodePaths: JSON.parse(nodeOutput) as string[],
                };
            }),
        );

        for (const { bunPaths, exports: groupExports, nodePaths } of resolutionResults) {
            expect(bunPaths).toHaveLength(groupExports.length);
            expect(nodePaths).toHaveLength(groupExports.length);
            for (const [index, { conditions }] of groupExports.entries()) {
                expect(bunPaths[index]?.endsWith(conditions.bun.slice(1))).toBe(true);
                expect(nodePaths[index]?.endsWith(conditions.import.slice(1))).toBe(true);
            }
        }
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
                ...(name === 'git' && { '@caxri/utils': 'workspace:*' }),
                'caxri': 'workspace:*',
            });
            expect(manifest.version).toBe(appManifest.version);
            expect(manifest.engines?.caxri).toBe(`^${appManifest.version}`);
            expect(manifest.scripts).toEqual({
                build: `bun run --cwd ../.. scripts/build-extension.ts --extension-root extensions/${name}`,
                typecheck: 'bun check --no-script -p tsconfig.json',
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

    it('keeps release version preparation aligned with current extension workspaces', async () => {
        const instructions = await readFile(join(workspaceRoot, 'RELEASING.md'), 'utf8');
        const releaseManifestPaths = await discoverReleaseManifestPaths(workspaceRoot);

        expect(instructions).toContain('bun run release:prepare -- patch');
        expect(instructions).toContain('extensions/{fixture,git,status}/package.json');
        for (const extension of ['fixture', 'git', 'status']) {
            expect(releaseManifestPaths).toContain(`extensions/${extension}/package.json`);
        }
        expect(releaseManifestPaths).not.toContain('extensions/files/package.json');
    });

    it('keeps Files in Workbench Core instead of an extension workspace', async () => {
        /**
         * Workspace identity comes from the manifest. Ignored build output may outlive the removed Files extension on a
         * developer machine and must not make the current source tree look like it still declares that workspace.
         */
        const filesExtensionManifest = join(workspaceRoot, 'extensions', 'files', 'package.json');
        await expect(access(filesExtensionManifest)).rejects.toMatchObject({
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
