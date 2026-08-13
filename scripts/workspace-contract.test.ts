import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const nativeDesktopDependencies = ['@parcel/watcher', 'better-sqlite3', 'electron', 'node-pty'];

interface PackageManifest {
    build?: { files?: string[] };
    dependencies?: Record<string, string>;
    name?: string;
    packageManager?: string;
    private?: boolean;
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

    it('keeps the CLI production graph free of Desktop native modules', () => {
        expect(protocolManifest.name).toBe('@caxri/protocol');
        expect(cliManifest.name).toBe('@caxri/cli');
        expect(cliManifest.dependencies).toEqual({ '@caxri/protocol': '0.0.6' });
        for (const dependency of nativeDesktopDependencies) {
            expect(cliManifest.dependencies).not.toHaveProperty(dependency);
            expect(protocolManifest.dependencies ?? {}).not.toHaveProperty(dependency);
        }
    });

    it('excludes workspace links from implicit Desktop packaging', () => {
        expect(rootManifest.build?.files).toContain('!node_modules/@caxri/cli{,/**}');
        expect(rootManifest.build?.files).toContain('!node_modules/@caxri/protocol{,/**}');
    });
});
