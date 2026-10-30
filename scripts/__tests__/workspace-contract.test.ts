import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import mobileRuntimeConfigText from '../../apps/mobile/tsconfig.runtime.json?raw';
import nodeConfigText from '../../tsconfig.node.json?raw';
import webConfigText from '../../tsconfig.web.json?raw';
import {
    appBoundaries,
    legacyOwnershipRoots,
    packageBoundaries,
    transitionalCycleAllowances,
    transitionalImportAllowances,
} from '../architecture-boundaries';

const root = resolve(import.meta.dirname, '../..');
const nativeDesktopDependencies = [
    '@parcel/watcher',
    '@vscode/ripgrep-universal',
    'better-sqlite3',
    'electron',
    'node-pty',
];

interface PackageManifest {
    bin?: unknown;
    build?: {
        asarUnpack?: string[];
        extraMetadata?: { main?: string; name?: string; productName?: string };
        extraResources?: Array<{ from?: string; to?: string }>;
        files?: string[];
    };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files?: string[];
    main?: string;
    name?: string;
    packageManager?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    version?: string;
    exports?: Record<string, unknown>;
    devEngines?: { packageManager?: unknown };
    workspaces?: unknown;
}

function manifest(path: string): PackageManifest {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function productionTypeScriptFiles(directory: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (['dist', 'node_modules', '__tests__'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...productionTypeScriptFiles(path));
        else if (/\.ts$/u.test(entry.name) && !/\.(?:spec|test)\.ts$/u.test(entry.name))
            found.push(path);
    }
    return found;
}

function looseTestFiles(directory: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (['dist', 'node_modules', '__tests__'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...looseTestFiles(path));
        else if (/\.(?:spec|test)\.ts$/u.test(entry.name)) found.push(path);
    }
    return found;
}

function protocolDeepImports(source: string): string[] {
    const pattern =
        /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]*packages\/protocol\/src(?:\/[^'"]*)?|@caxri\/protocol\/[^'"]+)['"]/gu;
    return source
        .matchAll(pattern)
        .map((match) => match[1])
        .toArray();
}

describe('pnpm workspace contract', () => {
    const rootManifest = manifest(join(root, 'package.json'));
    const agentSkillsManifest = manifest(join(root, 'packages/agent-skills/package.json'));
    const clientManifest = manifest(join(root, 'packages/client/package.json'));
    const mobileTransportManifest = manifest(join(root, 'packages/mobile-transport/package.json'));
    const protocolManifest = manifest(join(root, 'packages/protocol/package.json'));
    const systemManifest = manifest(join(root, 'packages/system/package.json'));
    const utilitiesManifest = manifest(join(root, 'packages/utils/package.json'));
    const cliManifest = manifest(join(root, 'apps/cli/package.json'));
    const desktopManifest = manifest(join(root, 'apps/desktop/package.json'));
    const mobileManifest = manifest(join(root, 'apps/mobile/package.json'));
    const serverManifest = manifest(join(root, 'apps/server/package.json'));
    const extensionManifests = readdirSync(join(root, 'extensions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => manifest(join(root, 'extensions', entry.name, 'package.json')));

    it('defines the current ownership graph without empty application workspaces', () => {
        expect(appBoundaries.map(({ root }) => root)).toEqual([
            'apps/desktop',
            'apps/mobile',
            'apps/server',
            'apps/cli',
            'apps/relay',
        ]);
        expect(packageBoundaries.map(({ root }) => root)).toEqual([
            'packages/agent-skills',
            'packages/client',
            'packages/markdown',
            'packages/mobile-transport',
            'packages/protocol',
            'packages/extension-api',
            'packages/system',
            'packages/utils',
        ]);
        expect(packageBoundaries.find(({ id }) => id === 'extension-api')?.allowedPackages).toEqual(
            [],
        );

        const appsRoot = join(root, 'apps');
        if (!existsSync(appsRoot)) return;
        const appEntries = readdirSync(appsRoot, { withFileTypes: true });
        for (const entry of appEntries) {
            if (!entry.isDirectory()) continue;
            const packageManifest = manifest(join(appsRoot, entry.name, 'package.json'));
            expect(
                packageManifest.bin ??
                    packageManifest.main ??
                    packageManifest.scripts?.start ??
                    packageManifest.scripts?.dev,
                `apps/${entry.name} must be independently runnable`,
            ).toBeDefined();
        }
    });

    it('registers the mobile runtime and transport package as browser-safe boundaries', () => {
        const runtimeConfig = parseJsonc(mobileRuntimeConfigText) as {
            compilerOptions?: { lib?: string[]; types?: string[] };
        };

        expect(runtimeConfig.compilerOptions?.lib).toEqual(['ES2022', 'WebWorker']);
        expect(runtimeConfig.compilerOptions?.types).toEqual([]);
        expect(mobileManifest.dependencies).toMatchObject({
            '@caxri/mobile-transport': 'workspace:*',
            '@caxri/protocol': 'workspace:*',
        });
        expect(mobileManifest.devDependencies?.['@caxri/utils']).toBe('workspace:*');
        expect(serverManifest.dependencies?.['@caxri/mobile-transport']).toBe('workspace:*');
        expect(mobileTransportManifest.dependencies ?? {}).not.toHaveProperty('@caxri/system');
        expect(appBoundaries.find(({ id }) => id === 'mobile')).toMatchObject({
            allowedPackages: ['mobile-transport', 'protocol'],
            root: 'apps/mobile',
            testAllowedPackages: ['utils'],
        });
        expect(packageBoundaries.find(({ id }) => id === 'mobile-transport')).toMatchObject({
            allowedPackages: [],
            browserSafe: true,
            root: 'packages/mobile-transport',
        });
        expect(appBoundaries.find(({ id }) => id === 'server')?.allowedPackages).toContain(
            'mobile-transport',
        );
    });

    it('keeps packages importable only through explicit exports', () => {
        const packageEntries = readdirSync(join(root, 'packages'), { withFileTypes: true });
        for (const entry of packageEntries) {
            if (!entry.isDirectory()) continue;
            const packageManifest = manifest(join(root, 'packages', entry.name, 'package.json'));
            expect(packageManifest.exports, `packages/${entry.name}`).toBeDefined();
            expect(
                Object.keys(packageManifest.exports ?? {}),
                `packages/${entry.name}`,
            ).not.toEqual(expect.arrayContaining(['./src/*', './*']));
        }
    });

    it('removes every topology-migration allowance after the application moves', () => {
        expect(legacyOwnershipRoots).toEqual([]);
        expect(transitionalImportAllowances).toEqual([]);
        expect(transitionalCycleAllowances).toEqual([]);
    });

    it('keeps the completed topology free of legacy ownership roots and control sockets', () => {
        const legacyRoots = ['src', 'apps/server/src/host', 'apps/server/src/runtime'];
        expect(legacyRoots.filter((path) => existsSync(join(root, path)))).toEqual([]);

        // `caxri/architecture-boundaries` owns which files may import `node:net`; this scan covers text an import rule cannot.
        const legacyControlTransport = [
            ...productionTypeScriptFiles(join(root, 'apps/server/src/core')),
            ...productionTypeScriptFiles(join(root, 'packages/client/src/supervise')),
        ]
            .filter((path) =>
                /\b(?:host|runtime)\.sock\b|unix domain socket|\bUDS\b/iu.test(
                    readFileSync(path, 'utf8'),
                ),
            )
            .map((path) => relative(root, path));
        expect(legacyControlTransport).toEqual([]);
    });

    it('registers current source discovery in TypeScript', () => {
        expect(nodeConfigText).toContain('"apps/desktop/src/main/**/*.ts"');
        expect(nodeConfigText).toContain('"apps/server/**/*.ts"');
        expect(nodeConfigText).not.toContain('"apps/**/*.tsx"');
        expect(webConfigText).toContain('"apps/desktop/src/renderer/src/**/*.tsx"');
        expect(webConfigText).toContain('"packages/client/src/connection/**/*.ts"');
        expect(webConfigText).toContain('"packages/client/src/state/**/*.ts"');
        expect(webConfigText).not.toContain('"packages/client/src/**/*.ts"');
        expect(webConfigText).toContain('"packages/extension-api/src/**/*.ts"');
        expect(webConfigText).not.toContain('"packages/agent-skills/src/**/*.ts"');
    });

    it('keeps tests, Electron support, protocol, and CLI domains in predictable directories', () => {
        const scriptRootTests = readdirSync(join(root, 'scripts'), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
            .map((entry) => entry.name);
        const e2eRootSupport = readdirSync(join(root, 'e2e'), { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.e2e.ts'),
            )
            .map((entry) => entry.name);
        const protocolRoot = join(root, 'packages/protocol/src');
        const protocolRootFiles = readdirSync(protocolRoot, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
        const protocolDomains = readdirSync(protocolRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
            .map((entry) => entry.name)
            .toSorted((left, right) => left.localeCompare(right));

        expect(scriptRootTests).toEqual([]);
        expect(e2eRootSupport).toEqual([]);
        expect(protocolRootFiles).toEqual(['index.ts']);
        expect(protocolDomains).toEqual([
            'agent',
            'configuration',
            'desktop',
            'device-store',
            'domain',
            'mobile',
            'registry',
            'transport',
        ]);
        for (const domain of protocolDomains) {
            expect(readdirSync(join(protocolRoot, domain)), `${domain} protocol barrel`).toContain(
                'index.ts',
            );
        }

        const cliRoot = join(root, 'apps/cli/src');
        const cliDomains = readdirSync(cliRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
            .map((entry) => entry.name)
            .toSorted((left, right) => left.localeCompare(right));
        expect(cliDomains).toEqual(['commands']);
        for (const domain of cliDomains) {
            expect(readdirSync(join(cliRoot, domain)), `${domain} CLI barrel`).toContain(
                'index.ts',
            );
        }
        expect(looseTestFiles(cliRoot), 'CLI tests must live in __tests__/').toEqual([]);
    });

    it('keeps every executable CLI path on the application workspace', () => {
        expect(existsSync(join(root, 'packages/cli'))).toBe(false);
        const legacySegmentedPath = /['"]packages['"]\s*,\s*['"]cli['"]/u;
        const violations = ['apps', 'e2e', '.agents/skills/acceptance/scripts']
            .flatMap((directory) => productionTypeScriptFiles(join(root, directory)))
            .filter((file) => legacySegmentedPath.test(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file));

        expect(violations).toEqual([]);
    });

    it('routes workspace tests through named Vitest projects', () => {
        expect(protocolManifest.scripts?.test).toContain('--project protocol');
        expect(agentSkillsManifest.scripts?.test).toContain('--project agent-skills');
        expect(clientManifest.scripts?.test).toContain('--project client');
        expect(cliManifest.scripts?.test).toContain('--project cli');
        expect(desktopManifest.scripts?.test).toBe(
            'vitest run --root ../.. --project desktop-parallel apps/desktop/src',
        );
        expect(serverManifest.scripts?.test).toContain('--project server-parallel');
        expect(systemManifest.scripts?.test).toContain('--project system');
        expect(rootManifest.scripts?.['typecheck:api']).toBe('pnpm --filter caxri run typecheck');
        expect(rootManifest.scripts?.['test:protocol']).toBe(
            'pnpm --filter @caxri/protocol run test',
        );
        expect(rootManifest.scripts?.['build:cli']).toBe('pnpm --filter @caxri/cli run build');
        expect(rootManifest.scripts?.['typecheck:workspaces']).toBe(
            "pnpm --recursive --filter './apps/*' --filter './packages/*' --filter './extensions/*' run typecheck",
        );
        expect(rootManifest.scripts?.['test:workspaces']).toBe(
            "pnpm --recursive --filter './apps/*' --filter './packages/*' run test",
        );
        expect(rootManifest.scripts?.['build:workspaces']).toBe(
            "pnpm --recursive --filter './apps/*' --filter './packages/*' --filter './extensions/*' --filter '!@caxri/desktop' --filter '!@caxri/server' --if-present run build && pnpm --filter @caxri/server run build",
        );
        expect(rootManifest.scripts?.['link:cli']).toBe(
            'bun run build:cli && bun run apps/cli/scripts/link-global.ts',
        );
        expect(rootManifest.scripts?.['unlink:cli']).toBe('pnpm remove --global @caxri/cli');
    });

    it('builds workspace distributions before Desktop development and production builds', () => {
        expect(rootManifest.name).toBe('@caxri/workspace');
        expect(rootManifest.main).toBeUndefined();
        expect(rootManifest.scripts?.['electron:install']).toBe('install-electron');
        expect(rootManifest.scripts?.dev).toBe(
            'bun run build:workspaces && bun run electron:install && bun run scripts/development.ts',
        );
        expect(rootManifest.scripts?.['dev:desktop']).toBe(
            'bun run electron:install && bun run scripts/development.ts',
        );
        expect(rootManifest.scripts?.build).toBe(
            'bun run scripts/build-receipt.ts begin && bun run build:workspaces && bun run build:desktop && bun run build:share-extension && bun run scripts/build-receipt.ts record',
        );
        expect(desktopManifest).toMatchObject({
            main: '../../out/main/index.js',
            name: '@caxri/desktop',
            private: true,
            version: rootManifest.version,
        });
        expect(serverManifest).toMatchObject({
            main: 'dist/server/bundles/server-core.js',
            name: '@caxri/server',
            private: true,
            version: rootManifest.version,
        });
        // Electron derives `app.name` (used by the macOS About/Hide menu labels) from the packaged package.json
        // `productName`; `build.productName` alone only names the bundle and Info.plist.
        expect(rootManifest.build?.extraMetadata).toEqual({
            main: 'out/main/index.js',
            name: '@caxri/desktop',
            productName: 'Caxri',
        });
    });

    it('keeps the CLI production graph free of Desktop native modules', () => {
        expect(protocolManifest.name).toBe('@caxri/protocol');
        expect(cliManifest.name).toBe('@caxri/cli');
        expect(protocolManifest.dependencies).toEqual({
            '@caxri/utils': 'workspace:*',
            'fuse.js': '^7.5.0',
            'zod': 'catalog:',
        });
        expect(rootManifest.devDependencies?.['@caxri/cli']).toBeUndefined();
        expect(cliManifest.dependencies).toEqual({
            '@caxri/agent-skills': 'workspace:*',
            '@caxri/client': 'workspace:*',
            '@caxri/protocol': 'workspace:*',
            '@caxri/system': 'workspace:*',
            'jsonc-parser': '^3.3.1',
            'zod': 'catalog:',
        });
        for (const dependency of nativeDesktopDependencies) {
            expect(cliManifest.dependencies).not.toHaveProperty(dependency);
            expect(agentSkillsManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            expect(clientManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            expect(protocolManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            expect(systemManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            for (const extensionManifest of extensionManifests)
                expect(
                    extensionManifest.dependencies ?? {},
                    `${extensionManifest.name}: native production dependency`,
                ).not.toHaveProperty(dependency);
        }
        expect(serverManifest.dependencies?.['@vscode/ripgrep-universal']).toBe('^1.18.0');
        expect(desktopManifest.dependencies ?? {}).not.toHaveProperty('@vscode/ripgrep-universal');
        expect(rootManifest.devDependencies ?? {}).not.toHaveProperty('@vscode/ripgrep-universal');
    });

    /**
     * Relative `.js` extensions in every package's emitted ESM are enforced by `caxri/relative-import-extension`.
     */
    it('keeps protocol and utility source browser-safe', () => {
        const sourceFiles = [
            ...productionTypeScriptFiles(join(root, 'packages/protocol/src')),
            ...productionTypeScriptFiles(join(root, 'packages/utils/src')),
        ];
        const forbiddenImport =
            /(?:from\s|import\s*\()\s*['"](?:node:|electron(?:[/'"]|$)|node-pty(?:[/'"]|$)|better-sqlite3(?:[/'"]|$)|@parcel\/watcher(?:[/'"]|$))/u;

        for (const file of sourceFiles) {
            const source = readFileSync(file, 'utf8');
            expect(source.match(forbiddenImport), file).toBeNull();
        }
    });

    it('emits shared pure utilities for system and standalone artifact consumers', () => {
        expect(utilitiesManifest.files).toEqual(['dist']);
        expect(utilitiesManifest.exports?.['.']).toEqual({
            bun: './src/index.ts',
            types: './src/index.ts',
            import: './dist/index.js',
        });
        expect(utilitiesManifest.scripts?.build).toBe('tsc -p tsconfig.build.json');
    });

    it('removes the shared IPC compatibility layer once consumers use the protocol package', () => {
        expect(existsSync(join(root, 'src'))).toBe(false);
    });

    it('keeps Server Core and Extension Host production imports on the protocol package root', () => {
        expect(
            protocolDeepImports(`
import '@caxri/protocol';
export type { TreeItemDto } from '@caxri/protocol/domain/views';
const dynamicProtocol = import('@caxri/protocol/src/index');
const requiredProtocol = require('@caxri/protocol');
`),
        ).toEqual(['@caxri/protocol/domain/views', '@caxri/protocol/src/index']);
        const violations = ['apps/server/src/core', 'apps/server/src/extension-host']
            .flatMap((directory) => productionTypeScriptFiles(join(root, directory)))
            .flatMap((file) => {
                const filePath = relative(root, file);
                return protocolDeepImports(readFileSync(file, 'utf8')).map(
                    (specifier) => `${filePath} -> ${specifier}`,
                );
            });

        expect(violations).toEqual([]);
    });

    it('loads node-pty only at the Terminal Host process composition root', () => {
        const engineSource = readFileSync(
            join(root, 'apps/server/src/terminal-host/engine/engine.ts'),
            'utf8',
        );
        const processSource = readFileSync(
            join(root, 'apps/server/src/terminal-host/process.ts'),
            'utf8',
        );

        expect(engineSource).toContain("import type * as pty from 'node-pty';");
        expect(engineSource).not.toContain("import * as pty from 'node-pty';");
        expect(processSource).toContain("import * as pty from 'node-pty';");
        expect(processSource).toContain('spawn: pty.spawn');
    });

    it('keeps generated workspace distributions outside source linting', async () => {
        const eslint = new ESLint({ cwd: root });

        await expect(
            eslint.isPathIgnored(join(root, 'packages/protocol/dist/index.js')),
        ).resolves.toBe(true);
        await expect(eslint.isPathIgnored(join(root, 'apps/cli/dist/caxri.cjs'))).resolves.toBe(
            true,
        );
    });
});
