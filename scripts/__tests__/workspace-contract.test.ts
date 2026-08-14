import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const nativeDesktopDependencies = ['@parcel/watcher', 'better-sqlite3', 'electron', 'node-pty'];

interface PackageManifest {
    build?: { files?: string[] };
    dependencies?: Record<string, string>;
    name?: string;
    packageManager?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    workspaces?: string[];
}

function manifest(path: string): PackageManifest {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function lockfiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['dist', 'node_modules', '__tests__'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...productionTypeScriptFiles(path));
        else if (/\.ts$/u.test(entry.name) && !/\.(?:spec|test)\.ts$/u.test(entry.name))
            found.push(path);
    }
    return found;
}

function discoversAllProtocolTests(script: string): boolean {
    const protocolSourceRoot = 'packages/protocol/src';
    const targets = script
        .split(/\s+/u)
        .map((token) => token.replace(/^["']|["']$/gu, ''))
        .filter((token) => token.startsWith(protocolSourceRoot));

    if (targets.some((target) => /\/[^*\s]+\.test\.ts$/u.test(target))) return false;

    return targets.some(
        (target) =>
            target === protocolSourceRoot ||
            (target.startsWith(`${protocolSourceRoot}/`) &&
                target.includes('**') &&
                target.endsWith('.test.ts')),
    );
}

describe('npm workspace contract', () => {
    const rootManifest = manifest(join(root, 'package.json'));
    const protocolManifest = manifest(join(root, 'packages/protocol/package.json'));
    const cliManifest = manifest(join(root, 'packages/cli/package.json'));

    it('keeps one private npm workspace root and one lockfile', () => {
        expect(rootManifest.private).toBe(true);
        expect(rootManifest.packageManager).toBe('npm@12.0.2');
        expect(rootManifest.workspaces).toEqual(['packages/*']);
        expect(lockfiles(root).map((path) => basename(path))).toEqual(['package-lock.json']);
    });

    it('keeps tests, Electron support, and protocol domains in predictable directories', () => {
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
            .sort();

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
    });

    it('discovers every protocol test without a concrete test-file allowlist', () => {
        const testScript = protocolManifest.scripts?.test ?? '';

        expect(
            discoversAllProtocolTests(testScript),
            `protocol test script must discover ${'packages/protocol/src'} recursively: ${testScript}`,
        ).toBe(true);
        expect(
            discoversAllProtocolTests(
                'vitest run --root ../.. packages/protocol/src/__tests__/index.test.ts',
            ),
        ).toBe(false);
    });

    it('keeps the CLI production graph free of Desktop native modules', () => {
        expect(protocolManifest.name).toBe('@caxri/protocol');
        expect(cliManifest.name).toBe('@caxri/cli');
        expect(cliManifest.dependencies).toEqual({ '@caxri/protocol': '0.0.6' });
        for (const dependency of nativeDesktopDependencies) {
            expect(cliManifest.dependencies).not.toHaveProperty(dependency);
            expect(protocolManifest.dependencies ?? {}).not.toHaveProperty(dependency);
        }
    });

    it('keeps protocol source browser-safe and emitted ESM imports resolvable by Node.js', () => {
        const sourceFiles = productionTypeScriptFiles(join(root, 'packages/protocol/src'));
        const forbiddenImport =
            /(?:from\s+|import\s*\()\s*['"](?:node:|electron(?:\/|['"]|$)|node-pty(?:\/|['"]|$)|better-sqlite3(?:\/|['"]|$)|@parcel\/watcher(?:\/|['"]|$))/u;
        const relativeImport = /(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu;

        for (const file of sourceFiles) {
            const source = readFileSync(file, 'utf8');
            expect(source.match(forbiddenImport), file).toBeNull();
            for (const match of source.matchAll(relativeImport)) {
                expect(match[1], `${file}: relative ESM import`).toMatch(/\.js$/u);
            }
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
