import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

/**
 * `replace` mode's own file: `mutations.integration.test.ts` already sits at the repository's
 * 800-line file gate (AGENTS.md), and these cases only need the same minimal fixture the other
 * file also builds locally (there is no shared fixture module across `__tests__/mutations-*` files
 * in this domain), so duplicating the small helper here keeps both files under the limit instead of
 * introducing a new cross-file dependency for four tests.
 */
interface Fixture {
    database: CaxriDatabase;
    directory: string;
    root: string;
    service: FileService;
    sessionId: string;
}

const fixtures: Fixture[] = [];
async function createFixture(prefix: string): Promise<Fixture> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    const rootInput = join(directory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const service = new FileService(
        database,
        () => {},
        new StructuredLogger(join(directory, 'logs')),
        () => 1024,
    );
    const fixture = { database, directory, root, service, sessionId: session.id };
    fixtures.push(fixture);
    return fixture;
}

afterEach(async () => {
    const pending = fixtures.slice();
    fixtures.length = 0;
    await Promise.all(
        pending.map(async ({ database, directory, service }) => {
            await service.close();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }),
    );
});

describe('FileMutationService move replace mode', () => {
    it('atomically overwrites an existing file target and logs the overwrite', async () => {
        const { directory, root, service, sessionId } = await createFixture(
            'caxri-file-move-replace-',
        );
        const source = join(root, 'source.txt');
        const destination = join(root, 'destination');
        const target = join(destination, 'source.txt');
        await Promise.all([writeFile(source, 'replacement', 'utf8'), mkdir(destination)]);
        await writeFile(target, 'existing', 'utf8');

        const moved = await service.move({
            sessionId,
            path: source,
            directory: destination,
            conflict: 'replace',
        });

        expect(moved).toMatchObject({
            kind: 'file',
            name: 'source.txt',
            path: target,
            previousPath: source,
        });
        await expect(readFile(target, 'utf8')).resolves.toBe('replacement');
        await expect(access(source)).rejects.toThrow();
        const moveLogs = (await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown as Record<string, unknown>)
            .filter((record) => record.event === 'file.moved');
        expect(moveLogs.at(-1)?.fields).toMatchObject({ replaced: true });
    });

    it('moves into an empty slot without claiming a replacement happened', async () => {
        const { directory, root, service, sessionId } = await createFixture(
            'caxri-file-move-replace-empty-',
        );
        const source = join(root, 'source.txt');
        const destination = join(root, 'destination');
        await Promise.all([writeFile(source, 'content', 'utf8'), mkdir(destination)]);

        const moved = await service.move({
            sessionId,
            path: source,
            directory: destination,
            conflict: 'replace',
        });

        expect(moved.path).toBe(join(destination, 'source.txt'));
        const moveLogs = (await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown as Record<string, unknown>)
            .filter((record) => record.event === 'file.moved');
        expect(moveLogs.at(-1)?.fields).not.toHaveProperty('replaced');
    });

    it('refuses a directory target and leaves both sides untouched', async () => {
        const { root, service, sessionId } = await createFixture(
            'caxri-file-move-replace-dir-target-',
        );
        const source = join(root, 'source.txt');
        const destination = join(root, 'destination');
        const target = join(destination, 'source.txt');
        await Promise.all([writeFile(source, 'content', 'utf8'), mkdir(destination)]);
        await mkdir(target);

        await expect(
            service.move({ sessionId, path: source, directory: destination, conflict: 'replace' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(source, 'utf8')).resolves.toBe('content');
        expect((await stat(target)).isDirectory()).toBe(true);
    });

    it('refuses to move a directory source even onto an existing target', async () => {
        const { root, service, sessionId } = await createFixture(
            'caxri-file-move-replace-dir-source-',
        );
        const folder = join(root, 'folder');
        const destination = join(root, 'destination');
        const target = join(destination, 'folder');
        await Promise.all([mkdir(folder), mkdir(destination)]);
        await writeFile(target, 'existing', 'utf8');

        await expect(
            service.move({ sessionId, path: folder, directory: destination, conflict: 'replace' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(target, 'utf8')).resolves.toBe('existing');
        expect((await stat(folder)).isDirectory()).toBe(true);
    });
});
