import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

/**
 * Registers a GitService so afterEach can close it before the temp directories are removed; otherwise an in-flight
 * metadata-watcher subscription races directory cleanup and its fallback logging rejects with ENOENT after the logger's
 * directory is gone.
 */
function trackGitService(git: GitService): GitService {
    gitServices.push(git);
    return git;
}

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((service) => service.close()));
    /**
     * Drain logs after their producers stop, before queued writes can race directory removal.
     */
    const loggersToFlush = [...loggers];
    loggers.length = 0;
    await Promise.all(loggersToFlush.map((logger) => logger.flush()));
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function commit(cwd: string, message: string): Promise<void> {
    await execFileAsync('git', ['add', '.'], { cwd });
    await execFileAsync('git', ['commit', '-m', message], { cwd });
}

describe('Git commit history', () => {
    it('pages machine-delimited commits, filters a subtree, and exposes merge details', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-history-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await execFileAsync('mkdir', ['-p', join(root, 'src'), join(root, 'docs')]);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: root });

        await writeFile(join(root, 'src', 'base.ts'), 'base\n', 'utf8');
        await commit(root, '初始提交');
        await writeFile(join(root, 'docs', 'guide.md'), 'docs\n', 'utf8');
        await commit(root, 'docs only');
        await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: root });
        await writeFile(join(root, 'src', 'feature.ts'), 'feature\n', 'utf8');
        await commit(root, '功能提交');
        await execFileAsync('git', ['checkout', 'main'], { cwd: root });
        await writeFile(join(root, 'docs', 'main.md'), 'main\n', 'utf8');
        await commit(root, 'main docs');
        await execFileAsync('git', ['merge', '--no-ff', 'feature', '-m', 'merge 功能'], {
            cwd: root,
        });

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const logger = createLogger(join(directory, 'logs'));
        const git = trackGitService(new GitService(new ProjectRootResolver(database), logger));
        const repo = (await git.summary(session.id)).repositories[0];
        const parameters = {
            sessionId: session.id,
            repositoryId: repo.id,
            offset: 0,
            pageSize: 2,
        } as const;

        const [first, concurrent] = await Promise.all([
            git.commits(parameters),
            git.commits(parameters),
        ]);
        expect(concurrent).toEqual(first);
        expect(first.commits).toHaveLength(2);
        expect(first.nextOffset).toBe(2);
        expect(first.commits[0]).toMatchObject({
            subject: 'merge 功能',
            author: 'Caxri Test',
            authorEmail: 'test@example.com',
            body: '',
            parents: [
                expect.stringMatching(/^[0-9a-f]{40}$/),
                expect.stringMatching(/^[0-9a-f]{40}$/),
            ],
        });
        expect(first.commits[0].decorations).toContain('HEAD -> main');
        expect(first.commits[0].authoredAt).toBeGreaterThan(0);

        const second = await git.commits({ ...parameters, offset: first.nextOffset! });
        expect(second.commits).toHaveLength(2);
        expect(second.nextOffset).toBe(4);
        const final = await git.commits({ ...parameters, offset: second.nextOffset! });
        expect(final.commits).toHaveLength(1);
        expect(final.nextOffset).toBeUndefined();
        expect(
            [...first.commits, ...second.commits, ...final.commits].map((item) => item.subject),
        ).toContain('功能提交');

        const subtree = await git.commits({ ...parameters, pageSize: 10, path: 'src' });
        expect(subtree.commits.map((item) => item.subject)).not.toContain('docs only');
        expect(subtree.commits.map((item) => item.subject)).not.toContain('main docs');
        expect(subtree.commits.map((item) => item.subject)).toEqual(
            expect.arrayContaining(['merge 功能', '功能提交', '初始提交']),
        );

        const details = await git.commitDetails({
            sessionId: session.id,
            repositoryId: repo.id,
            sha: first.commits[0].sha,
            path: 'src',
        });
        expect(details.commit.parents).toHaveLength(2);
        expect(details.files).toContainEqual({
            path: 'src/feature.ts',
            status: 'added',
            additions: 1,
            deletions: 0,
        });
        expect(details.filesTruncated).toBe(false);
        // The merge brings in `feature\n` via its first parent: one added line, nothing deleted.
        expect(details.additions).toBe(1);
        expect(details.deletions).toBe(0);
        await expect(git.commits({ ...parameters, path: directory })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
        // A partial or nonexistent path is expected while the user types into the history filter;
        // it must surface as NOT_FOUND, not a generic INTERNAL failure from the raw ENOENT.
        await expect(git.commits({ ...parameters, path: 'does-not-exist' })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });

        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; fields?: { operation?: string } });
        expect(
            records.filter(
                (record) => record.event === 'git.command' && record.fields?.operation === 'log',
            ),
        ).toHaveLength(4);
        database.close();
    });

    it('resolves file-level head commits and per-commit file diffs', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-filehead-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await execFileAsync('mkdir', ['-p', join(root, 'src')], {});
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: root });

        await writeFile(join(root, 'src', 'app.ts'), 'one\n', 'utf8');
        await execFileAsync('git', ['add', '.'], { cwd: root });
        await execFileAsync(
            'git',
            ['commit', '-m', 'feat: add app', '-m', 'Body line 1\n\nBody line 2'],
            { cwd: root },
        );
        await writeFile(join(root, 'src', 'app.ts'), 'two\n', 'utf8');
        await commit(root, 'fix: change app');
        await writeFile(join(root, 'src', 'untracked.ts'), 'loose\n', 'utf8');

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const logger = createLogger(join(directory, 'logs'));
        const git = trackGitService(new GitService(new ProjectRootResolver(database), logger));
        const repo = (await git.summary(session.id)).repositories[0];

        const head = await git.fileHead({ sessionId: session.id, path: 'src/app.ts' });
        expect(head).toMatchObject({
            subject: 'fix: change app',
            author: 'Caxri Test',
            authorEmail: 'test@example.com',
            body: '',
            path: 'src/app.ts',
            repositoryId: repo.id,
        });
        expect(await git.fileHead({ sessionId: session.id, path: 'src/untracked.ts' })).toBeNull();
        expect(await git.fileHead({ sessionId: session.id, path: 'src/missing.ts' })).toBeNull();

        await execFileAsync('git', ['mv', 'src/app.ts', 'src/renamed.ts'], { cwd: root });
        await git.summary(session.id, 1);
        await expect(
            git.fileHead({ sessionId: session.id, path: 'src/renamed.ts' }),
        ).resolves.toMatchObject({
            subject: 'fix: change app',
            path: 'src/app.ts',
            repositoryId: repo.id,
        });

        const page = await git.commits({
            sessionId: session.id,
            repositoryId: repo.id,
            offset: 0,
            pageSize: 10,
        });
        const rootCommit = page.commits.find((item) => item.subject === 'feat: add app')!;
        expect(rootCommit.body).toBe('Body line 1\n\nBody line 2');

        // `fix: change app` rewrites the single line of src/app.ts: one addition, one deletion.
        const headDetails = await git.commitDetails({
            sessionId: session.id,
            repositoryId: repo.id,
            sha: head!.sha,
        });
        expect(headDetails).toMatchObject({ additions: 1, deletions: 1 });

        const changed = await git.commitDiffDocument({
            sessionId: session.id,
            repositoryId: repo.id,
            sha: head!.sha,
            path: 'src/app.ts',
        });
        expect(changed).toMatchObject({
            format: 'contents',
            path: 'src/app.ts',
            original: 'one\n',
            modified: 'two\n',
        });
        const added = await git.commitDiffDocument({
            sessionId: session.id,
            repositoryId: repo.id,
            sha: rootCommit.sha,
            path: 'src/app.ts',
        });
        expect(added).toMatchObject({ original: '', modified: 'one\n' });
        await expect(
            git.commitDiffDocument({
                sessionId: session.id,
                repositoryId: repo.id,
                sha: head!.sha,
                path: 'src/not-in-commit.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        // A committed binary blob must never reach the text diff as mojibake contents; it falls
        // back to Git's own bounded patch output instead.
        await writeFile(join(root, 'src', 'blob.bin'), Uint8Array.from([0, 1, 2, 253, 254, 255]));
        await commit(root, 'chore: add binary blob');
        const binaryHead = await git.fileHead({ sessionId: session.id, path: 'src/blob.bin' });
        const binaryDiff = await git.commitDiffDocument({
            sessionId: session.id,
            repositoryId: repo.id,
            sha: binaryHead!.sha,
            path: 'src/blob.bin',
        });
        expect(binaryDiff.format).toBe('patch');
        expect(binaryDiff.modified).toContain('Binary files');
        database.close();
    });
});
