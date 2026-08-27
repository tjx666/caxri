import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageDevelopmentTestExtension } from './test-extension';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('stageDevelopmentTestExtension', () => {
    it('installs only the built fixture inputs into the isolated profile', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-e2e-extension-stage-'));
        temporaryDirectories.push(root);
        const source = join(root, 'extensions', 'fixture');
        const userData = join(root, 'user-data');
        await Promise.all([
            mkdir(join(source, 'dist'), { recursive: true }),
            mkdir(join(source, 'media'), { recursive: true }),
            mkdir(join(source, 'src'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(source, 'package.json'), '{"name":"caxri.fixture"}\n'),
            writeFile(join(source, 'dist', 'extension.js'), 'export {};\n'),
            writeFile(join(source, 'media', 'fixture.svg'), '<svg/>\n'),
            writeFile(join(source, 'src', 'extension.ts'), 'export {};\n'),
        ]);

        await stageDevelopmentTestExtension(root, userData);

        const destination = join(userData, 'extensions', 'caxri.fixture');
        expect(
            (await readdir(destination)).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['dist', 'media', 'package.json']);
        await expect(readFile(join(destination, 'dist', 'extension.js'), 'utf8')).resolves.toBe(
            'export {};\n',
        );
    });
});
