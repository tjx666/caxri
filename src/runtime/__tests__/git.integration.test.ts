import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import { CaxriDatabase } from '../database';
import { describeGitFailure, GitService } from '../git';
import { WorkspacePaths } from '../workspace-paths';

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
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = new StructuredLogger(join(directory, '.logs'));
        const paths = new WorkspacePaths(database);
        const git = new GitService(paths, logger);
        const [summary, concurrentSummary] = await Promise.all([
            git.summary(session.id),
            git.summary(session.id),
        ]);
        expect(summary.isRepository).toBe(true);
        expect(concurrentSummary).toEqual(summary);
        expect(summary.repositories[0].branch).toBe('main');
        expect(summary.repositories[0].files.map((file) => file.path)).toEqual(
            expect.arrayContaining(['tracked.txt', 'new.txt']),
        );
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        durationMs?: number;
                        fields?: { operation?: string };
                    },
            );
        const statusRecords = records.filter(
            (record) => record.event === 'git.command' && record.fields?.operation === 'status',
        );
        expect(statusRecords).toHaveLength(1);
        expect(statusRecords[0].durationMs).toBeTypeOf('number');
        expect(
            await git.diff(session.id, summary.repositories[0].id, join(directory, 'tracked.txt')),
        ).toContain('-before');
        await expect(
            git.diffDocument(
                session.id,
                summary.repositories[0].id,
                join(directory, 'tracked.txt'),
            ),
        ).resolves.toEqual({
            format: 'contents',
            path: 'tracked.txt',
            original: 'before\n',
            modified: 'after\n',
        });
        await expect(
            git.diffDocument(session.id, summary.repositories[0].id, 'new.txt'),
        ).resolves.toEqual({
            format: 'contents',
            path: 'new.txt',
            original: '',
            modified: 'new\n',
        });
        database.close();
    });

    it('recognizes an empty repository before its first commit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-empty-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = new StructuredLogger(join(directory, '.logs'));
        const paths = new WorkspacePaths(database);
        const summary = await new GitService(paths, logger).summary(session.id);

        expect(summary).toMatchObject({
            isRepository: true,
            repositories: [expect.objectContaining({ branch: 'main' })],
        });
        expect(summary.repositories[0].head).toBeUndefined();
        database.close();
    });

    it('returns diff documents for staged gitlinks, renames, and untracked directories', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-special-diffs-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'primary');
        const submoduleSource = join(directory, 'submodule-source');
        await execFileAsync('mkdir', ['-p', root, submoduleSource]);
        for (const repository of [root, submoduleSource]) {
            await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
            await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                cwd: repository,
            });
            await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
                cwd: repository,
            });
        }
        await writeFile(join(root, 'old.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'old.txt'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'submodule initial'], {
            cwd: submoduleSource,
        });
        await execFileAsync(
            'git',
            ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
            { cwd: root },
        );
        await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });
        await execFileAsync('git', ['mv', 'old.txt', 'renamed.txt'], { cwd: root });
        await execFileAsync('mkdir', ['-p', join(root, 'generated')]);
        await writeFile(join(root, 'generated/new.txt'), 'new\n', 'utf8');
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'advance submodule'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['add', 'vendor/sub'], { cwd: root });

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const git = new GitService(
            new WorkspacePaths(database),
            new StructuredLogger(join(directory, 'logs')),
        );
        const repository = (await git.summary(session.id)).repositories[0];

        expect(repository.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'renamed',
                    originalPath: 'old.txt',
                    path: 'renamed.txt',
                }),
                expect.objectContaining({ kind: 'untracked', path: 'generated/new.txt' }),
                expect.objectContaining({ index: 'M', path: 'vendor/sub' }),
            ]),
        );
        await expect(
            git.diffDocument(session.id, repository.id, 'renamed.txt'),
        ).resolves.toMatchObject({
            original: 'before\n',
            originalPath: 'old.txt',
            modified: 'before\n',
        });
        await expect(
            git.diffDocument(session.id, repository.id, 'generated/new.txt'),
        ).resolves.toMatchObject({ original: '', modified: 'new\n' });
        const submoduleDocument = await git.diffDocument(session.id, repository.id, 'vendor/sub');
        expect(submoduleDocument.format).toBe('patch');
        expect(submoduleDocument.modified).toContain('Subproject commit');
        database.close();
    });

    it('discovers approved worktrees, nested repositories, and submodules independently', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-hierarchy-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'primary');
        const linked = join(directory, 'linked');
        const submoduleSource = join(directory, 'submodule-source');
        await execFileAsync('mkdir', ['-p', root, submoduleSource]);

        for (const repository of [root, submoduleSource]) {
            await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
            await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                cwd: repository,
            });
            await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
                cwd: repository,
            });
        }
        await writeFile(join(root, 'root.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'root.txt'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
        await writeFile(join(submoduleSource, 'submodule.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'submodule.txt'], { cwd: submoduleSource });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: submoduleSource });
        await execFileAsync('git', ['worktree', 'add', '-b', 'feature', linked], { cwd: root });
        await execFileAsync(
            'git',
            ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
            { cwd: root },
        );
        await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });

        const nested = join(root, 'nested');
        await execFileAsync('mkdir', ['-p', nested]);
        await execFileAsync('git', ['init', '-b', 'nested-main'], { cwd: nested });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: nested });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: nested });
        await writeFile(join(nested, 'nested.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'nested.txt'], { cwd: nested });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: nested });
        await Promise.all([
            writeFile(join(root, 'root.txt'), 'after\n', 'utf8'),
            writeFile(join(linked, 'root.txt'), 'linked\n', 'utf8'),
            writeFile(join(nested, 'nested.txt'), 'after\n', 'utf8'),
            writeFile(join(root, 'vendor/sub/submodule.txt'), 'after\n', 'utf8'),
        ]);

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const primaryProject = database.createProject(root);
        database.createProject(linked);
        const session = database.createSession(primaryProject.id, 'shell').session;
        const logger = new StructuredLogger(join(directory, 'logs'));
        const paths = new WorkspacePaths(database);
        const git = new GitService(paths, logger);
        const startedAt = performance.now();
        const summary = await git.summary(session.id);
        const repositories = summary.repositories;

        expect(performance.now() - startedAt).toBeLessThan(3_000);
        expect(repositories.map((repository) => repository.kind).sort()).toEqual([
            'nested',
            'primary',
            'submodule',
            'worktree',
        ]);
        const primary = repositories.find((repository) => repository.kind === 'primary')!;
        expect(primary.files.map((file) => file.path).sort()).toEqual(['root.txt', 'vendor/sub']);
        expect(primary.files.find((file) => file.path === 'vendor/sub')).toMatchObject({
            kind: 'modified',
            workingTree: 'M',
        });
        expect(primary.files.some((file) => file.path.startsWith('nested'))).toBe(false);
        for (const repository of repositories.filter((item) => item.kind !== 'primary')) {
            expect(repository.files).toHaveLength(1);
            await expect(
                git.diff(session.id, repository.id, repository.files[0].path),
            ).resolves.toContain('-before');
        }
        await expect(git.diff(session.id, primary.id, 'root.txt')).resolves.toContain('-before');
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
        ).toBe('The Project root is not a Git repository.');
    });
});
