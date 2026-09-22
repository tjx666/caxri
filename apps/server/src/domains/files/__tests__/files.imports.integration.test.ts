import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    const pending = cleanups.slice();
    cleanups.length = 0;
    for (const cleanup of pending) {
        // eslint-disable-next-line no-await-in-loop -- each fixture drains its owned resources before removal
        await cleanup();
    }
});

async function fixture() {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-imports-'));
    const directory = await realpath(temporaryDirectory);
    const root = join(directory, 'project');
    await mkdir(root);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const logger = new StructuredLogger(join(directory, 'logs'));
    const service = new FileService(
        database,
        () => {},
        logger,
        () => 1024,
    );
    cleanups.push(async () => {
        await service.close();
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    });
    return {
        directory,
        root,
        async write(path: string, content = '') {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), content);
        },
        resolve(from: string, specifiers: string[]) {
            return service.resolveImports({
                sessionId: session.id,
                from: join(root, from),
                specifiers,
            });
        },
    };
}

describe('FileService import resolution', () => {
    it('uses the nearest config, inherited path origins and ordered wildcard fallbacks', async () => {
        const project = await fixture();
        await project.write(
            'configs/base.json',
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        '@/*': ['../shared/*'],
                        '@special/*': ['../missing/*', '../special/*'],
                    },
                },
            }),
        );
        await project.write('apps/one/tsconfig.json', '{ "extends": "../../configs/base", }');
        await project.write(
            'apps/two/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
        );
        await Promise.all(
            [
                'apps/one/main.ts',
                'apps/two/main.ts',
                'shared/value.ts',
                'special/value/index.ts',
                'apps/two/src/value.ts',
            ].map((path) => project.write(path)),
        );
        expect(await project.resolve('apps/one/main.ts', ['@/value', '@special/value'])).toEqual({
            resolved: [
                { specifier: '@/value', path: join(project.root, 'shared/value.ts') },
                { specifier: '@special/value', path: join(project.root, 'special/value/index.ts') },
            ],
        });
        expect(await project.resolve('apps/two/main.ts', ['@/value'])).toEqual({
            resolved: [{ specifier: '@/value', path: join(project.root, 'apps/two/src/value.ts') }],
        });
    });

    it('refreshes inherited config changes and newly created nearer configs without a restart', async () => {
        const project = await fixture();
        await project.write('tsconfig.json', '{ "extends": "./base" }');
        await project.write(
            'base.json',
            '{ "compilerOptions": { "paths": { "@/*": ["first/*"] } } }',
        );
        await Promise.all(
            ['nested/main.ts', 'first/value.ts', 'second/value.ts'].map((path) =>
                project.write(path),
            ),
        );
        expect((await project.resolve('nested/main.ts', ['@/value'])).resolved[0]?.path).toBe(
            join(project.root, 'first/value.ts'),
        );
        await project.write(
            'base.json',
            '{ "compilerOptions": { "paths": { "@/*": ["second/*"] } } }',
        );
        expect((await project.resolve('nested/main.ts', ['@/value'])).resolved[0]?.path).toBe(
            join(project.root, 'second/value.ts'),
        );
        await project.write(
            'nested/tsconfig.json',
            '{ "compilerOptions": { "paths": { "@/*": ["../first/*"] } } }',
        );
        expect((await project.resolve('nested/main.ts', ['@/value'])).resolved[0]?.path).toBe(
            join(project.root, 'first/value.ts'),
        );
    });

    it('refuses outside candidates and circular configs while retaining authorized link entry paths', async () => {
        const project = await fixture();
        await writeFile(join(project.directory, 'outside.ts'), 'export {};');
        await project.write('main.ts');
        await symlink(project.directory, join(project.root, 'linked'));
        await project.write(
            'tsconfig.json',
            '{ "compilerOptions": { "paths": { "outside": ["../outside"], "linked": ["linked/outside"] } } }',
        );
        expect(await project.resolve('main.ts', ['outside', 'linked'])).toEqual({
            resolved: [{ specifier: 'linked', path: join(project.root, 'linked/outside.ts') }],
        });
        await project.write('tsconfig.json', '{ "extends": "./tsconfig" }');
        expect(await project.resolve('main.ts', ['linked'])).toEqual({ resolved: [] });
    });

    it.each(['{ invalid', ' '.repeat(256 * 1024 + 1), '{ "extends": "../outside.json" }'])(
        'leaves invalid or unauthorized configuration unresolved',
        async (config) => {
            const project = await fixture();
            await project.write('main.ts');
            await project.write('value.ts');
            await writeFile(
                join(project.directory, 'outside.json'),
                '{ "compilerOptions": { "paths": { "alias": ["project/value"] } } }',
            );
            await project.write('tsconfig.json', config);
            expect(await project.resolve('main.ts', ['alias'])).toEqual({ resolved: [] });
        },
    );
});
