import { access, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FileMutationOperation } from '../../../shared/types';
import { StructuredLogger } from '../../../shared/node/logger';
import { FileMutationJournal } from '../mutation-journal';

const temporaryDirectories: string[] = [];

function createOperation(
    id: string,
    directory: string,
    sessionId = 'session-1',
): FileMutationOperation {
    const now = Date.now();
    return {
        id,
        kind: 'create',
        sessionId,
        phase: 'pre_stage',
        input: { directory, kind: 'file', name: `${id}.txt` },
        startedAt: now,
        updatedAt: now,
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('FileMutationJournal', () => {
    it('times out a stuck pre-stage operation before it can mutate files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-pre-stage-'));
        temporaryDirectories.push(directory);
        const gate = Promise.withResolvers<void>();
        const journal = new FileMutationJournal(
            join(directory, 'operations.json'),
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { preStageTimeoutMs: 10 },
        );
        await journal.initialize();
        const target = join(directory, 'operation-1.txt');
        const pending = journal.run(createOperation('operation-1', directory), async (stage) => {
            await gate.promise;
            const result = { kind: 'file' as const, name: 'operation-1.txt', path: target };
            await stage(result);
            await writeFile(target, 'created', 'utf8');
            return result;
        });

        await expect.poll(() => journal.get('operation-1')).toMatchObject({ phase: 'canceled' });
        await journal.acknowledge('operation-1');
        gate.resolve();
        await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
        await expect(access(target)).rejects.toThrow();
        await journal.close();
    });

    it('keeps a staged operation running after cancellation and records its final result', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-staged-'));
        temporaryDirectories.push(directory);
        const release = Promise.withResolvers<void>();
        const journal = new FileMutationJournal(
            join(directory, 'operations.json'),
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
        );
        await journal.initialize();
        const result = {
            kind: 'file' as const,
            name: 'operation-2.txt',
            path: join(directory, 'operation-2.txt'),
        };
        const pending = journal.run(createOperation('operation-2', directory), async (stage) => {
            await stage(result);
            await release.promise;
            await writeFile(result.path, 'completed', 'utf8');
            return result;
        });

        await expect.poll(() => journal.get('operation-2')).toMatchObject({ phase: 'staged' });
        await expect(journal.cancel('operation-2')).resolves.toMatchObject({ phase: 'staged' });
        release.resolve();
        await expect(pending).resolves.toEqual(result);
        await expect(journal.get('operation-2')).resolves.toMatchObject({
            phase: 'completed',
            result,
        });
        await journal.close();
    });

    it('reconciles a staged move after Runtime restarts before recording completion', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-restart-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const source = join(directory, 'source.txt');
        const target = join(directory, 'target.txt');
        await writeFile(source, 'preserved', 'utf8');
        const sourceStats = await lstat(source, { bigint: true });
        const logger = new StructuredLogger(join(directory, 'logs'));
        const first = new FileMutationJournal(path, () => undefined, logger);
        await first.initialize();
        const never = new Promise<never>(() => undefined);
        const startedAt = Date.now();
        const pending = first.run(
            {
                id: 'operation-3',
                kind: 'rename',
                sessionId: 'session-1',
                phase: 'pre_stage',
                input: { name: 'target.txt', path: source },
                startedAt,
                updatedAt: startedAt,
            },
            async (stage) => {
                const result = {
                    device: sourceStats.dev.toString(),
                    inode: sourceStats.ino.toString(),
                    kind: 'file' as const,
                    name: 'target.txt',
                    path: target,
                    previousPath: source,
                };
                await stage(result);
                await rename(source, target);
                await never;
                return result;
            },
        );
        void pending.catch(() => undefined);
        await expect.poll(() => first.get('operation-3')).toMatchObject({ phase: 'staged' });
        await expect(access(target)).resolves.toBeUndefined();
        await first.close();

        const recovered = new FileMutationJournal(path, () => undefined, logger);
        await recovered.initialize();
        await expect(recovered.get('operation-3')).resolves.toMatchObject({
            phase: 'completed',
            result: { path: target, previousPath: source },
        });
        await expect(access(source)).rejects.toThrow();
        await recovered.close();
    });

    it('reconciles a created file from its confirmed post-create identity after restart', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-create-restart-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const target = join(directory, 'created.txt');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const first = new FileMutationJournal(path, () => undefined, logger);
        await first.initialize();
        const pending = first.run(
            createOperation('operation-create-restart', directory),
            async (stage) => {
                const result = { kind: 'file' as const, name: 'created.txt', path: target };
                await stage(result);
                await writeFile(target, 'created', 'utf8');
                const stats = await lstat(target, { bigint: true });
                await stage({
                    ...result,
                    device: stats.dev.toString(),
                    inode: stats.ino.toString(),
                });
                await new Promise<never>(() => undefined);
                return result;
            },
        );
        void pending.catch(() => undefined);
        await expect
            .poll(async () => (await first.get('operation-create-restart'))?.phase)
            .toBe('staged');
        const staged = await first.get('operation-create-restart');
        if (staged?.kind !== 'create') throw new Error('Expected a staged create operation');
        expect(typeof staged.expectedResult?.device).toBe('string');
        expect(typeof staged.expectedResult?.inode).toBe('string');
        await first.close();

        const recovered = new FileMutationJournal(path, () => undefined, logger);
        await recovered.initialize();

        await expect(recovered.get('operation-create-restart')).resolves.toMatchObject({
            phase: 'completed',
            result: { path: target },
        });
        await expect(readFile(target, 'utf8')).resolves.toBe('created');
        await recovered.close();
    });

    it('does not accept a foreign target replacement while reconciling a staged move', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-foreign-target-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const source = join(directory, 'source.txt');
        const target = join(directory, 'target.txt');
        const preserved = join(directory, 'preserved.txt');
        await writeFile(source, 'original', 'utf8');
        const sourceStats = await lstat(source, { bigint: true });
        const logger = new StructuredLogger(join(directory, 'logs'));
        const first = new FileMutationJournal(path, () => undefined, logger);
        await first.initialize();
        const pending = first.run(
            {
                id: 'operation-foreign-target',
                kind: 'rename',
                sessionId: 'session-1',
                phase: 'pre_stage',
                input: { name: 'target.txt', path: source },
                startedAt: 1,
                updatedAt: 1,
            },
            async (stage) => {
                const expected = {
                    device: sourceStats.dev.toString(),
                    inode: sourceStats.ino.toString(),
                    kind: 'file' as const,
                    name: 'target.txt',
                    path: target,
                    previousPath: source,
                };
                await stage(expected);
                await rename(source, target);
                await rename(target, preserved);
                await writeFile(target, 'foreign', 'utf8');
                await new Promise<never>(() => undefined);
                return expected;
            },
        );
        void pending.catch(() => undefined);
        await expect
            .poll(() => first.get('operation-foreign-target'))
            .toMatchObject({
                phase: 'staged',
            });
        await first.close();

        const recovered = new FileMutationJournal(path, () => undefined, logger);
        await recovered.initialize();

        await expect(recovered.get('operation-foreign-target')).resolves.toMatchObject({
            phase: 'failed',
        });
        await expect(readFile(target, 'utf8')).resolves.toBe('foreign');
        await expect(readFile(preserved, 'utf8')).resolves.toBe('original');
        await recovered.close();
    });

    it('retries final persistence in-process after the native mutation succeeded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-final-retry-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const source = join(directory, 'source.txt');
        const target = join(directory, 'target.txt');
        await writeFile(source, 'preserved', 'utf8');
        const sourceStats = await lstat(source, { bigint: true });
        let writes = 0;
        const journal = new FileMutationJournal(
            path,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                completionRetryBaseMs: 1,
                writeJournal: async (journalPath, sourceText) => {
                    writes += 1;
                    if (writes === 3) throw new Error('journal temporarily unavailable');
                    await writeFile(journalPath, sourceText, 'utf8');
                },
            },
        );
        await journal.initialize();
        const startedAt = Date.now();
        const result = {
            kind: 'file' as const,
            name: 'target.txt',
            path: target,
            previousPath: source,
        };

        await expect(
            journal.run(
                {
                    id: 'operation-final-retry',
                    kind: 'rename',
                    sessionId: 'session-1',
                    phase: 'pre_stage',
                    input: { name: 'target.txt', path: source },
                    startedAt,
                    updatedAt: startedAt,
                },
                async (stage) => {
                    await stage({
                        ...result,
                        device: sourceStats.dev.toString(),
                        inode: sourceStats.ino.toString(),
                    });
                    await rename(source, target);
                    return result;
                },
            ),
        ).rejects.toThrow('journal temporarily unavailable');
        await expect
            .poll(async () => (await journal.get('operation-final-retry'))?.phase)
            .toBe('completed');
        await expect(readFile(target, 'utf8')).resolves.toBe('preserved');
        await journal.close();
    });

    it('retries create identity persistence after the native creation succeeded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-create-retry-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const target = join(directory, 'created.txt');
        let writes = 0;
        const journal = new FileMutationJournal(
            path,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                completionRetryBaseMs: 1,
                writeJournal: async (journalPath, sourceText) => {
                    writes += 1;
                    if (writes === 3) throw new Error('journal temporarily unavailable');
                    await writeFile(journalPath, sourceText, 'utf8');
                },
            },
        );
        await journal.initialize();
        const result = { kind: 'file' as const, name: 'created.txt', path: target };

        await expect(
            journal.run(createOperation('operation-create-retry', directory), async (stage) => {
                await stage(result);
                await writeFile(target, 'created', 'utf8');
                const stats = await lstat(target, { bigint: true });
                await stage({
                    ...result,
                    device: stats.dev.toString(),
                    inode: stats.ino.toString(),
                });
                return result;
            }),
        ).rejects.toThrow('journal temporarily unavailable');
        await expect
            .poll(async () => (await journal.get('operation-create-retry'))?.phase)
            .toBe('completed');
        await expect(readFile(target, 'utf8')).resolves.toBe('created');
        await journal.close();
    });

    it('refuses to complete a retry after the created target identity changes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-create-conflict-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'operations.json');
        const target = join(directory, 'created.txt');
        const replacement = join(directory, 'replacement.txt');
        let writes = 0;
        const journal = new FileMutationJournal(
            path,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                completionRetryBaseMs: 100,
                writeJournal: async (journalPath, sourceText) => {
                    writes += 1;
                    if (writes === 3) throw new Error('journal temporarily unavailable');
                    await writeFile(journalPath, sourceText, 'utf8');
                },
            },
        );
        await journal.initialize();
        const result = { kind: 'file' as const, name: 'created.txt', path: target };

        await expect(
            journal.run(createOperation('operation-create-conflict', directory), async (stage) => {
                await stage(result);
                await writeFile(target, 'created', 'utf8');
                const stats = await lstat(target, { bigint: true });
                await stage({
                    ...result,
                    device: stats.dev.toString(),
                    inode: stats.ino.toString(),
                });
                return result;
            }),
        ).rejects.toThrow('journal temporarily unavailable');
        await writeFile(replacement, 'foreign', 'utf8');
        await rename(replacement, target);

        await expect
            .poll(async () => (await journal.get('operation-create-conflict'))?.phase)
            .toBe('failed');
        await expect(readFile(target, 'utf8')).resolves.toBe('foreign');
        await journal.close();
    });

    it('bounds active mutations within one Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-journal-capacity-'));
        temporaryDirectories.push(directory);
        const journal = new FileMutationJournal(
            join(directory, 'operations.json'),
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { maximumActivePerSession: 1, preStageTimeoutMs: 30_000 },
        );
        await journal.initialize();
        const never = new Promise<never>(() => undefined);
        const first = journal.run(createOperation('operation-4', directory), () => never);
        void first.catch(() => undefined);

        await expect.poll(() => journal.get('operation-4')).toMatchObject({ phase: 'pre_stage' });
        await expect(
            journal.run(createOperation('operation-5', directory), () => never),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        await journal.cancel('operation-4');
        await journal.acknowledge('operation-4');
        await expect(
            journal.run(createOperation('operation-6', directory), () => {
                throw new Error('Canceled execution incorrectly released its capacity');
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        await journal.close();
    });
});
