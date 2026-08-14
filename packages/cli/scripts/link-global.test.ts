import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareGlobalCliPackage } from './link-global';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe('global CLI package', () => {
    it('creates a dependency-free executable package from the standalone bundle', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-global-cli-'));
        temporaryDirectories.push(root);
        await mkdir(join(root, 'dist'), { recursive: true });
        await writeFile(
            join(root, 'package.json'),
            JSON.stringify({
                name: '@caxri/cli',
                version: '0.0.6',
                engines: { node: '>=24.0.0' },
            }),
            'utf8',
        );
        const sourceBundle = join(root, 'dist', 'caxri.cjs');
        await writeFile(sourceBundle, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
        await chmod(sourceBundle, 0o644);

        const globalRoot = await prepareGlobalCliPackage(root);
        const manifest = JSON.parse(
            await readFile(join(globalRoot, 'package.json'), 'utf8'),
        ) as Record<string, unknown>;

        expect(manifest).toEqual({
            name: '@caxri/cli',
            version: '0.0.6',
            private: true,
            bin: { caxri: './caxri.cjs' },
            engines: { node: '>=24.0.0' },
        });
        expect(await readFile(join(globalRoot, 'caxri.cjs'), 'utf8')).toBe(
            '#!/usr/bin/env node\nconsole.log("ok");\n',
        );
        expect((await stat(join(globalRoot, 'caxri.cjs'))).mode & 0o111).not.toBe(0);
    });
});
