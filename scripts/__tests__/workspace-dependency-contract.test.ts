import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');

interface RootPackageManifest {
    'build'?: {
        asarUnpack?: string[];
        extraResources?: Array<{ from?: string; to?: string }>;
    };
    'dependencies'?: Record<string, string>;
    'devDependencies'?: Record<string, string>;
    'devEngines'?: { packageManager?: unknown };
    'lint-staged'?: Record<string, string[]>;
    'packageManager'?: string;
    'private'?: boolean;
    'workspaces'?: unknown;
}

interface PnpmWorkspace {
    allowBuilds?: Record<string, boolean>;
    catalog?: Record<string, string>;
    overrides?: Record<string, string>;
    packages?: string[];
}

function lockfiles(directory: string, scanRoot = directory): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(directory, entry.name);
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
        /**
         * Claude Code may place ignored task worktrees inside the checkout. They are independent repositories rather
         * than Caxri workspace members, so scanning them makes one valid root lockfile appear duplicated locally.
         */
        if (entry.isDirectory() && relative(scanRoot, path) === '.claude/worktrees') continue;
        if (entry.isDirectory()) found.push(...lockfiles(path, scanRoot));
        else if (
            /^(?:bun\.lockb?|npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.(?:json|yaml)|yarn\.lock)$/u.test(
                entry.name,
            )
        )
            found.push(path);
    }
    return found;
}

/**
 * Dependency ownership for the whole workspace: the single root lockfile, the catalog and override policy, and a root
 * orchestrator that ships no product runtime dependency. Workspace topology and boundaries live in
 * `workspace-contract.test.ts`.
 */
describe('pnpm dependency contract', () => {
    const rootManifest = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
    ) as RootPackageManifest;
    const workspace = parse(
        readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    ) as PnpmWorkspace;

    it('keeps one private pnpm workspace root and one lockfile without manifest pinning', () => {
        expect(rootManifest.private).toBe(true);
        expect(rootManifest.packageManager).toBeUndefined();
        expect(rootManifest.devEngines?.packageManager).toBeUndefined();
        expect(rootManifest.workspaces).toBeUndefined();
        expect(workspace.packages).toEqual(['apps/*', 'extensions/*', 'packages/*']);
        /*
         * Membership and range shape, deliberately not the version numbers. What this case is named after — no
         * manifest pinning — is a property of the range, and a catalog written out version by version instead
         * asserted a snapshot of one afternoon: every routine `pnpm update` failed here with nothing wrong, which
         * teaches the next reader to edit the expectation rather than read it.
         */
        expect(Object.keys(workspace.catalog ?? {})).toEqual([
            '@ronradtke/react-native-markdown-display',
            '@tanstack/react-query',
            '@types/semver',
            '@types/ws',
            '@yutengjing/eslint-config-typescript',
            '@yutengjing/prettier-config',
            'eslint-plugin-import-x',
            'expo-file-system',
            'expo-image-manipulator',
            'expo-image-picker',
            'expo-intent-launcher',
            'lucide-react-native',
            'markdownlint',
            'markdownlint-cli2',
            'oxlint',
            'oxlint-tsgolint',
            'prettier-plugin-tailwindcss',
            'prism-react-renderer',
            'react-qr-code',
            'react-scan',
            'semver',
            'sonda',
            'ws',
            'zod',
        ]);
        const catalogEntries = Object.entries(workspace.catalog ?? {});
        for (const [name, range] of catalogEntries) {
            // Expo-managed native modules follow the SDK-compatible tilde range in stack-baseline.md.
            const expectedRange = name.startsWith('expo-')
                ? /: ~\d+\.\d+\.\d+$/
                : /: \^\d+\.\d+\.\d+$/;
            expect(`${name}: ${range}`).toMatch(expectedRange);
        }
        expect(workspace.allowBuilds).toEqual({
            '@parcel/watcher': false,
            'better-sqlite3': true,
            'electron': true,
            'electron-winstaller': false,
            'esbuild': true,
            'node-pty': true,
            'unrs-resolver': true,
        });
        /*
         * Same reasoning as the catalog, inverted: the override policy is that a correction names an exact version,
         * so that is what is checked. The versions themselves move on purpose — `dompurify` tracks the newest
         * release rather than holding a security floor.
         */
        expect(Object.keys(workspace.overrides ?? {})).toEqual([
            'dompurify',
            'vitest>tinybench',
            'lodash-es',
            '@esbuild-kit/core-utils>esbuild',
            'xcode>uuid',
        ]);
        const overrideEntries = Object.entries(workspace.overrides ?? {});
        for (const [selector, version] of overrideEntries)
            expect(`${selector}: ${version}`).toMatch(/: \d+\.\d+\.\d+$/);
        expect(rootManifest.devDependencies?.['@oxlint/plugins']).toBe(workspace.catalog?.oxlint);
        // `--max-warnings=0` mirrors the `lint` script: ESLint exits 0 on a warning, so without it the hook lets
        // through exactly what CI rejects.
        expect(rootManifest['lint-staged']?.['*.{js,jsx,mjs,cjs}']?.[0]).toBe(
            'eslint --fix --no-warn-ignored --max-warnings=0',
        );
        expect(rootManifest['lint-staged']?.['*.{ts,tsx,mts,cts}']?.[0]).toBe(
            'eslint --fix --no-warn-ignored --max-warnings=0',
        );
        expect(
            lockfiles(root)
                .map((path) => basename(path))
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['pnpm-lock.yaml']);
    });

    it('ignores Claude Code task worktrees when enforcing the root lockfile contract', () => {
        const fixture = mkdtempSync(join(tmpdir(), 'caxri-workspace-contract-'));
        try {
            const taskWorktree = join(fixture, '.claude', 'worktrees', 'task');
            mkdirSync(taskWorktree, { recursive: true });
            writeFileSync(join(fixture, 'pnpm-lock.yaml'), 'root\n');
            writeFileSync(join(taskWorktree, 'pnpm-lock.yaml'), 'task\n');

            expect(lockfiles(fixture).map((path) => relative(fixture, path))).toEqual([
                'pnpm-lock.yaml',
            ]);
        } finally {
            rmSync(fixture, { force: true, recursive: true });
        }
    });

    it('keeps the root private orchestrator free of product runtime dependencies', () => {
        expect(rootManifest.dependencies).toBeUndefined();
        expect(rootManifest.build?.asarUnpack).toBeUndefined();
        expect(rootManifest.build?.extraResources).toContainEqual({
            from: 'apps/server/dist/server',
            to: 'server',
        });
        expect(rootManifest.devDependencies).toMatchObject({
            'better-sqlite3': '^13.0.3',
            'node-pty': '^1.1.0',
            'ws': 'catalog:',
        });
    });
});
