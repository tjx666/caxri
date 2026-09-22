import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ImportConfigFiles } from '../config-files';
import { packageEntryTargets, packageFileCandidates, PackageImports } from '../packages';

describe('package entry targets', () => {
    it('prefers type conditions, including nested runtime exports', () => {
        expect(
            packageEntryTargets(
                {
                    exports: {
                        import: { types: './types.d.ts', default: './index.js' },
                        default: './fallback.js',
                    },
                },
                '',
            ),
        ).toEqual(['./types.d.ts', './index.js']);
    });

    it('honors exact null entries and the longest wildcard without leaking private files', () => {
        const metadata = {
            main: './main.js',
            exports: {
                './*': './dist/*.js',
                './feature/*': './special/*.js',
                './feature/private': null,
            },
        };
        expect(packageEntryTargets(metadata, 'feature/value')).toEqual(['./special/value.js']);
        expect(packageEntryTargets(metadata, 'feature/private')).toEqual([]);
        expect(packageEntryTargets(metadata, '')).toEqual([]);
        expect(packageEntryTargets({ exports: './index.js' }, 'private')).toEqual([]);
    });

    it('rejects traversal and invalid export targets', () => {
        for (const target of [
            '../outside.js',
            './nested/../../outside.js',
            './node_modules/other/index.js',
            './%2e%2e/outside.js',
            '/absolute.js',
        ]) {
            expect(packageEntryTargets({ exports: target }, '')).toEqual([]);
        }
    });

    it('orders legacy declaration fields before runtime fields', () => {
        expect(
            packageEntryTargets(
                {
                    types: './types.d.ts',
                    typings: './old.d.ts',
                    main: './main.js',
                    module: './module.js',
                },
                '',
            ),
        ).toEqual(['./types.d.ts', './old.d.ts', './main.js', './module.js', './index']);
    });
});

describe('package file candidates', () => {
    it('prefers declarations while keeping exact declaration and extensionless files reachable', () => {
        expect(packageFileCandidates('/package/index.mts')[0]).toBe('/package/index.d.mts');
        expect(packageFileCandidates('/package/index.cts')[0]).toBe('/package/index.d.cts');
        expect(packageFileCandidates('/package/index.d.ts')).toEqual(['/package/index.d.ts']);
        expect(packageFileCandidates('/package/index.mjs').slice(0, 2)).toEqual([
            '/package/index.d.mts',
            '/package/index.mjs',
        ]);
        expect(packageFileCandidates('/package/index.cjs').slice(0, 2)).toEqual([
            '/package/index.d.cts',
            '/package/index.cjs',
        ]);
        expect(packageFileCandidates('/package/entry').slice(0, 2)).toEqual([
            '/package/entry.d.ts',
            '/package/entry',
        ]);
    });
});

describe('package lookup cost', () => {
    it('authorizes only the ancestor that actually holds the package', async () => {
        // `realpath` because macOS reports the temp directory through a `/var` symlink, while authorization returns
        // the canonical path the package root is compared against.
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-package-imports-'));
        const baseRoot = await realpath(temporary);
        const root = join(baseRoot, 'project');
        const from = join(root, 'src', 'a', 'b', 'c', 'd', 'index.ts');
        await mkdir(dirname(from), { recursive: true });
        await writeFile(from, '', 'utf8');
        await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
        await writeFile(
            join(root, 'node_modules', 'pkg', 'package.json'),
            JSON.stringify({ types: './index.d.ts' }),
            'utf8',
        );

        const authorized: string[] = [];
        const files = new ImportConfigFiles(async (_sessionId, path) => {
            authorized.push(path);
            return { root, path: await realpath(path) };
        });
        const candidates = await new PackageImports(files).candidates(
            'session-1',
            { root, path: from },
            'pkg',
        );

        expect(candidates).toContain(join(root, 'node_modules', 'pkg', 'index.d.ts'));
        // Five ancestor levels are searched, but only the one holding `node_modules/pkg` reaches authorization, which
        // costs two SQLite reads plus lstat/realpath per call. A miss must not pay that; see `PackageImports.find`.
        expect(authorized).toEqual([
            join(root, 'node_modules', 'pkg'),
            join(root, 'node_modules', 'pkg', 'package.json'),
        ]);

        await rm(baseRoot, { force: true, recursive: true });
    });
});
