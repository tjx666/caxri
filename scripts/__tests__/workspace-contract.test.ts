import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const nativeDesktopDependencies = ['@parcel/watcher', 'better-sqlite3', 'electron', 'node-pty'];

interface PackageManifest {
    build?: { files?: string[] };
    dependencies?: Record<string, string>;
    name?: string;
    packageManager?: string;
    private?: boolean;
    scripts?: Record<string, string>;
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
            ['.git', '.records', 'competitors', 'node_modules', 'out', 'release'].includes(
                entry.name,
            )
        )
            continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...lockfiles(path));
        else if (/^(?:bun|npm-shrinkwrap|package-lock|pnpm-lock|yarn\.lock)/u.test(entry.name))
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

function isProtocolCompatibilityReExport(source: string): boolean {
    return /^export \* from ['"]\.\.\/\.\.\/\.\.\/packages\/protocol\/src\/(?:index|(?:agent|configuration|desktop|domain|registry|transport)\/[a-z0-9-]+)(?:\.js)?['"];\n?$/u.test(
        source,
    );
}

describe('pnpm workspace contract', () => {
    const rootManifest = manifest(join(root, 'package.json'));
    const protocolManifest = manifest(join(root, 'packages/protocol/package.json'));
    const cliManifest = manifest(join(root, 'packages/cli/package.json'));
    const workspace = parse(
        readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    ) as PnpmWorkspace;
    const mise = readFileSync(join(root, 'mise.toml'), 'utf8');

    it('keeps one private pnpm workspace root and one lockfile without manifest pinning', () => {
        expect(rootManifest.private).toBe(true);
        expect(rootManifest.packageManager).toBeUndefined();
        expect(rootManifest.devEngines?.packageManager).toBeUndefined();
        expect(rootManifest.workspaces).toBeUndefined();
        expect(workspace.packages).toEqual(['packages/*']);
        expect(workspace.catalog).toEqual({
            '@yutengjing/eslint-config-typescript': '^4.0.0',
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
        expect(mise).toContain('node = "24.19.0"');
        expect(mise).toContain('pnpm = "12.0.0-rc.5"');
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

        const cliRoot = join(root, 'packages/cli/src');
        const cliDomains = readdirSync(cliRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
            .map((entry) => entry.name)
            .toSorted((left, right) => left.localeCompare(right));
        expect(cliDomains).toEqual(['commands', 'host', 'skills']);
        for (const domain of cliDomains) {
            expect(readdirSync(join(cliRoot, domain)), `${domain} CLI barrel`).toContain(
                'index.ts',
            );
        }
        expect(looseTestFiles(cliRoot), 'CLI tests must live in __tests__/').toEqual([]);
    });

    it('routes workspace tests through named Vitest projects', () => {
        expect(protocolManifest.scripts?.test).toContain('--project protocol');
        expect(cliManifest.scripts?.test).toContain('--project cli');
        expect(rootManifest.scripts?.['link:cli']).toBe(
            'bun run build:cli && bun run packages/cli/scripts/link-global.ts',
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
        expect(rootManifest.dependencies?.['@caxri/cli']).toBe('workspace:*');
        expect(cliManifest.dependencies).toEqual({
            '@caxri/protocol': 'workspace:*',
            'zod': 'catalog:',
        });
        for (const dependency of nativeDesktopDependencies) {
            expect(cliManifest.dependencies).not.toHaveProperty(dependency);
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

    it('keeps shared IPC production files as protocol compatibility re-exports', () => {
        const sharedIpcRoot = join(root, 'src/shared/ipc');
        const sourceFiles = productionTypeScriptFiles(sharedIpcRoot);

        for (const file of sourceFiles) {
            expect(isProtocolCompatibilityReExport(readFileSync(file, 'utf8')), file).toBe(true);
        }
    });

    it('excludes workspace links from implicit Desktop packaging', () => {
        expect(rootManifest.build?.files).toContain('!node_modules/@caxri/cli{,/**}');
        expect(rootManifest.build?.files).toContain('!node_modules/@caxri/protocol{,/**}');
    });

    it('keeps generated workspace distributions outside source linting', async () => {
        const eslint = new ESLint({ cwd: root });

        await expect(
            eslint.isPathIgnored(join(root, 'packages/protocol/dist/index.js')),
        ).resolves.toBe(true);
        await expect(eslint.isPathIgnored(join(root, 'packages/cli/dist/caxri.cjs'))).resolves.toBe(
            true,
        );
    });
});
