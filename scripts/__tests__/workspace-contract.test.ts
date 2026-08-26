import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    appBoundaries,
    legacyOwnershipRoots,
    packageBoundaries,
    transitionalCycleAllowances,
    transitionalImportAllowances,
} from '../architecture-boundaries';

const root = resolve(import.meta.dirname, '../..');
const nativeDesktopDependencies = ['@parcel/watcher', 'better-sqlite3', 'electron', 'node-pty'];

interface PackageManifest {
    bin?: unknown;
    build?: { files?: string[] };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    main?: string;
    name?: string;
    packageManager?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    exports?: Record<string, unknown>;
    devEngines?: { packageManager?: unknown };
    workspaces?: unknown;
}

interface PnpmWorkspace {
    allowBuilds?: Record<string, boolean>;
    catalog?: Record<string, string>;
    overrides?: Record<string, string>;
    packages?: string[];
}

function manifest(path: string): PackageManifest {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function lockfiles(directory: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (
            [
                '.git',
                '.records',
                'competitors',
                'node_modules',
                'out',
                'release',
                'release.noindex',
            ].includes(entry.name)
        )
            continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...lockfiles(path));
        else if (
            /^(?:bun\.lockb?|npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.(?:json|yaml)|yarn\.lock)$/u.test(
                entry.name,
            )
        )
            found.push(path);
    }
    return found;
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
    const protocolManifest = manifest(join(root, 'packages/protocol/package.json'));
    const cliManifest = manifest(join(root, 'apps/cli/package.json'));
    const workspace = parse(
        readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    ) as PnpmWorkspace;

    it('keeps one private pnpm workspace root and one lockfile without manifest pinning', () => {
        expect(rootManifest.private).toBe(true);
        expect(rootManifest.packageManager).toBeUndefined();
        expect(rootManifest.devEngines?.packageManager).toBeUndefined();
        expect(rootManifest.workspaces).toBeUndefined();
        expect(workspace.packages).toEqual(['apps/*', 'extensions/*', 'packages/*']);
        expect(workspace.catalog).toEqual({
            '@types/semver': '^7.8.0',
            '@types/ws': '^8.18.1',
            '@yutengjing/eslint-config-typescript': '^4.0.0',
            '@yutengjing/prettier-config': '^2.0.0',
            'eslint-plugin-import-x': '^4.17.1',
            'markdownlint': '^0.41.1',
            'markdownlint-cli2': '^0.23.2',
            'oxlint': '^1.78.0',
            'oxlint-tsgolint': '^7.0.2001',
            'prettier-plugin-tailwindcss': '^0.8.1',
            'semver': '^7.8.5',
            'sonda': '^0.14.0',
            'ws': '^8.21.3',
            'zod': '4.4.3',
        });
        expect(workspace.allowBuilds).toEqual({
            '@parcel/watcher': false,
            'better-sqlite3': true,
            'electron': true,
            'electron-winstaller': false,
            'esbuild': true,
            'node-pty': true,
            'unrs-resolver': true,
        });
        expect(workspace.overrides).toEqual({ dompurify: '3.4.13' });
        expect(
            lockfiles(root)
                .map((path) => basename(path))
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['pnpm-lock.yaml']);
    });

    it('defines the target ownership graph without empty application workspaces', () => {
        expect(appBoundaries.map(({ root }) => root)).toEqual([
            'apps/desktop',
            'apps/server',
            'apps/cli',
        ]);
        expect(packageBoundaries.map(({ root }) => root)).toEqual([
            'packages/agent-skills',
            'packages/client',
            'packages/protocol',
            'packages/extension-api',
            'packages/utils',
        ]);

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

    it('binds every current-layout allowance to its removal batch', () => {
        const allowedBatches = ['A2b', 'A2c', 'A2d', 'A2e', 'A2f'];
        const allowances = [
            ...legacyOwnershipRoots,
            ...transitionalImportAllowances,
            ...transitionalCycleAllowances,
        ];

        expect(allowances.length).toBeGreaterThan(0);
        expect(transitionalImportAllowances).toEqual([]);
        expect(transitionalCycleAllowances).toEqual([]);
        for (const allowance of allowances) {
            const label = 'id' in allowance ? allowance.id : allowance.root;
            expect(allowedBatches, label).toContain(allowance.removeInBatch);
        }
        for (const allowance of transitionalImportAllowances) {
            expect(allowance.importer, allowance.id).not.toMatch(/[?*]/u);
            const importerSource = readFileSync(join(root, allowance.importer), 'utf8');
            for (const specifier of allowance.specifiers) {
                expect(specifier, allowance.id).not.toMatch(/[?*]/u);
                expect(importerSource, allowance.id).toContain(specifier);
            }
        }
    });

    it('pre-registers target source discovery in TypeScript', () => {
        const nodeConfig = readFileSync(join(root, 'tsconfig.node.json'), 'utf8');
        const webConfig = readFileSync(join(root, 'tsconfig.web.json'), 'utf8');

        expect(nodeConfig).toContain('"apps/desktop/src/main/**/*.ts"');
        expect(nodeConfig).toContain('"apps/server/**/*.ts"');
        expect(nodeConfig).not.toContain('"apps/**/*.tsx"');
        expect(webConfig).toContain('"apps/desktop/src/renderer/**/*.tsx"');
        expect(webConfig).toContain('"packages/client/src/connection/**/*.ts"');
        expect(webConfig).toContain('"packages/client/src/state/**/*.ts"');
        expect(webConfig).not.toContain('"packages/client/src/**/*.ts"');
        expect(webConfig).toContain('"packages/extension-api/src/**/*.ts"');
        expect(webConfig).not.toContain('"packages/agent-skills/src/**/*.ts"');
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
            'domain',
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

    it('routes workspace tests through named Vitest projects', () => {
        expect(protocolManifest.scripts?.test).toContain('--project protocol');
        expect(agentSkillsManifest.scripts?.test).toContain('--project agent-skills');
        expect(clientManifest.scripts?.test).toContain('--project client');
        expect(cliManifest.scripts?.test).toContain('--project cli');
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
            "pnpm --recursive --filter './apps/*' --filter './packages/*' --filter './extensions/*' --if-present run build",
        );
        expect(rootManifest.scripts?.['link:cli']).toBe(
            'bun run build:cli && bun run apps/cli/scripts/link-global.ts',
        );
        expect(rootManifest.scripts?.['unlink:cli']).toBe('pnpm remove --global @caxri/cli');
    });

    it('builds workspace distributions before Desktop development and production builds', () => {
        expect(rootManifest.scripts?.dev).toBe('bun run build:workspaces && electron-vite dev');
        expect(rootManifest.scripts?.build).toBe(
            'bun run build:workspaces && bun run build:desktop',
        );
    });

    it('keeps the CLI production graph free of Desktop native modules', () => {
        expect(protocolManifest.name).toBe('@caxri/protocol');
        expect(cliManifest.name).toBe('@caxri/cli');
        expect(protocolManifest.dependencies).toEqual({ zod: 'catalog:' });
        expect(rootManifest.devDependencies?.['@caxri/cli']).toBeUndefined();
        expect(cliManifest.dependencies).toEqual({
            '@caxri/agent-skills': 'workspace:*',
            '@caxri/client': 'workspace:*',
            '@caxri/protocol': 'workspace:*',
            'zod': 'catalog:',
        });
        for (const dependency of nativeDesktopDependencies) {
            expect(cliManifest.dependencies).not.toHaveProperty(dependency);
            expect(agentSkillsManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            expect(clientManifest.dependencies ?? {}).not.toHaveProperty(dependency);
            expect(protocolManifest.dependencies ?? {}).not.toHaveProperty(dependency);
        }
    });

    it('keeps protocol source browser-safe and emitted ESM imports resolvable by Node.js', () => {
        const sourceFiles = productionTypeScriptFiles(join(root, 'packages/protocol/src'));
        const forbiddenImport =
            /(?:from\s|import\s*\()\s*['"](?:node:|electron(?:[/'"]|$)|node-pty(?:[/'"]|$)|better-sqlite3(?:[/'"]|$)|@parcel\/watcher(?:[/'"]|$))/u;
        const relativeImport = /(?:from\s|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu;

        for (const file of sourceFiles) {
            const source = readFileSync(file, 'utf8');
            expect(source.match(forbiddenImport), file).toBeNull();
            for (const match of source.matchAll(relativeImport)) {
                expect(match[1], `${file}: relative ESM import`).toMatch(/\.js$/u);
            }
        }
    });

    it('removes the shared IPC compatibility layer once consumers use the protocol package', () => {
        const sharedIpcRoot = join(root, 'src/shared/ipc');
        expect(existsSync(sharedIpcRoot)).toBe(false);
    });

    it('keeps Host and Extension Host production imports on the protocol package root', () => {
        expect(
            protocolDeepImports(`
import '@caxri/protocol';
export type { TreeItemDto } from '@caxri/protocol/domain/views';
const dynamicProtocol = import('@caxri/protocol/src/index');
const requiredProtocol = require('@caxri/protocol');
`),
        ).toEqual(['@caxri/protocol/domain/views', '@caxri/protocol/src/index']);
        const violations = ['src/host', 'src/extension-host']
            .flatMap((directory) => productionTypeScriptFiles(join(root, directory)))
            .flatMap((file) => {
                const filePath = relative(root, file);
                return protocolDeepImports(readFileSync(file, 'utf8')).map(
                    (specifier) => `${filePath} -> ${specifier}`,
                );
            });

        expect(violations).toEqual([]);
    });

    it('keeps root production dependencies limited to packaged Desktop runtime modules', () => {
        /**
         * Electron-builder copies the production dependency tree into the asar. Native modules must remain external,
         * while `ws` is intentionally externalized by electron-vite for both Main and the standalone Host entry.
         * Workspace links and all other pure-JS dependencies stay bundled. See docs/bundle-size.md.
         */
        expect(
            Object.keys(rootManifest.dependencies ?? {}).toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(['@parcel/watcher', 'better-sqlite3', 'node-pty', 'ws']);
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
