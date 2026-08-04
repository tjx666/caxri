import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../database';
import { FileService } from '../files';
import { describeGitFailure, GitService } from '../git';
import { StructuredLogger } from '../logger';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('GitService', () => {
    it('reports read-only status and selected-file diff', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await writeFile(join(directory, 'new.txt'), 'new\n', 'utf8');
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(directory, 'shell').session;
        const logger = new StructuredLogger(join(directory, '.logs'));
        const files = new FileService(
            database,
            () => undefined,
            logger,
            () => 1024 * 1024,
        );
        const git = new GitService(files, logger);
        const [summary, concurrentSummary] = await Promise.all([
            git.summary(session.id),
            git.summary(session.id),
        ]);
        expect(summary.isRepository).toBe(true);
        expect(concurrentSummary).toEqual(summary);
        expect(summary.branch).toBe('main');
        expect(summary.files.map((file) => file.path)).toEqual(
            expect.arrayContaining(['tracked.txt', 'new.txt']),
        );
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; durationMs?: number });
        const statusRecords = records.filter((record) => record.event === 'git.command');
        expect(statusRecords).toHaveLength(1);
        expect(statusRecords[0].durationMs).toBeTypeOf('number');
        expect(await git.diff(session.id, join(directory, 'tracked.txt'))).toContain('-before');
        database.close();
    });

    it('recognizes an empty repository before its first commit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-empty-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(directory, 'shell').session;
        const logger = new StructuredLogger(join(directory, '.logs'));
        const files = new FileService(
            database,
            () => undefined,
            logger,
            () => 1024 * 1024,
        );
        const summary = await new GitService(files, logger).summary(session.id);

        expect(summary).toMatchObject({ isRepository: true, branch: 'main' });
        expect(summary.head).toBeUndefined();
        database.close();
    });
});

describe('describeGitFailure', () => {
    it('distinguishes missing Git and timeout failures from non-repositories', () => {
        expect(
            describeGitFailure(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })),
        ).toBe('Git is not installed or is unavailable on PATH.');
        expect(describeGitFailure(Object.assign(new Error('timed out'), { killed: true }))).toBe(
            'The Git operation timed out.',
        );
        expect(
            describeGitFailure(
                Object.assign(new Error('exit 128'), { stderr: 'fatal: not a git repository' }),
            ),
        ).toBe('The Session root is not a Git repository.');
    });
});
