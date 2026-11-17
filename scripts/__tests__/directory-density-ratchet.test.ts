import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DIRECTORY_DENSITY_FAMILIES,
    DIRECTORY_DENSITY_OWNERS,
    findUnlistedDenseDirectories,
    isDirectoryDensityPath,
} from '../directory-density-baseline';

const projectRoot = resolve(import.meta.dirname, '..', '..');

function listModules(directory: string, prefix = ''): string[] {
    return readdirSync(resolve(projectRoot, directory), { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.startsWith(prefix) &&
                /\.tsx?$/u.test(entry.name) &&
                !/\.test\.tsx?$/u.test(entry.name) &&
                !entry.name.endsWith('.d.ts'),
        )
        .map((entry) => entry.name);
}

/**
 * Tracked plus untracked source files, so a new file fails locally before it is committed.
 */
function listSourcePaths(): string[] {
    return execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.ts', '*.tsx'],
        { cwd: projectRoot, maxBuffer: 1 << 28 },
    )
        .toString()
        .split('\0')
        .filter((path) => path !== '' && existsSync(resolve(projectRoot, path)));
}

function expectAtCap(label: string, actual: number, cap: number): void {
    expect(
        actual,
        actual > cap
            ? `${label} grew to ${actual} (cap ${cap}). Put the new module in a cohesive subdirectory instead of raising the cap.`
            : `${label} shrank to ${actual} (cap ${cap}). Lower its cap in scripts/directory-density-baseline.ts to ${actual}.`,
    ).toBe(cap);
}

describe('directory density ratchet', () => {
    it.each(DIRECTORY_DENSITY_OWNERS)(
        'keeps $directory at its recorded direct module count',
        ({ cap, directory }) => {
            expectAtCap(directory, listModules(directory).length, cap);
        },
    );

    it.each(DIRECTORY_DENSITY_FAMILIES)(
        'keeps the $prefix* family in $directory at its recorded count',
        ({ cap, directory, prefix }) => {
            const count = listModules(directory, prefix).length;
            expect(
                count,
                `${directory}/${prefix}* is no longer a 3+ module family`,
            ).toBeGreaterThanOrEqual(3);
            expectAtCap(`${directory}/${prefix}*`, count, cap);
        },
    );

    it('records every dense directory in the tree as an owner', () => {
        expect(
            findUnlistedDenseDirectories(listSourcePaths()),
            'add these to DIRECTORY_DENSITY_OWNERS with their current module count',
        ).toEqual([]);
    });

    it('detects an unlisted dense directory in an injected file list', () => {
        const files = (directory: string, count: number, suffix = '.ts') =>
            Array.from({ length: count }, (_, index) => `${directory}/m${index}${suffix}`);
        const dense = files('apps/x/src/dense', 12);
        const ignored = [
            ...files('apps/x/src/tested', 12, '.test.ts'),
            ...files('apps/x/src/fixtures', 12),
            ...files('apps/x/src/i18n/locales/en', 12),
            ...files('e2e/support', 12),
        ];
        const small = files('apps/x/src/small', 11, '.tsx');
        expect(findUnlistedDenseDirectories([...dense, ...ignored, ...small], [])).toEqual([
            { count: 12, directory: 'apps/x/src/dense' },
        ]);
        expect(
            findUnlistedDenseDirectories(dense, [{ cap: 12, directory: 'apps/x/src/dense' }]),
        ).toEqual([]);
    });

    it('only records families that fit inside a recorded owner', () => {
        const owners = new Set(DIRECTORY_DENSITY_OWNERS.map(({ directory }) => directory));
        for (const family of DIRECTORY_DENSITY_FAMILIES) {
            expect(owners.has(family.directory), family.directory).toBe(true);
        }
    });

    it('classifies paths under guarded directories for CI routing', () => {
        expect(isDirectoryDensityPath('apps/desktop/src/main/new-module.ts')).toBe(true);
        expect(
            isDirectoryDensityPath('apps/server/src/domains/agent-chat/providers/claude/x.ts'),
        ).toBe(true);
        expect(isDirectoryDensityPath('apps/cli/src/main.ts')).toBe(false);
    });
});
