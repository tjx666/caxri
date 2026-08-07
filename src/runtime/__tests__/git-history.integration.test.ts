import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import { CaxriDatabase } from '../db/repository';
import { GitService } from '../git';
import { ProjectRootResolver } from '../project-roots';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
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
        const logger = new StructuredLogger(join(directory, 'logs'));
        const git = new GitService(new ProjectRootResolver(database), logger);
        const repository = (await git.summary(session.id)).repositories[0];
        const params = {
            sessionId: session.id,
            repositoryId: repository.id,
            offset: 0,
            pageSize: 2,
        } as const;

        const [first, concurrent] = await Promise.all([git.commits(params), git.commits(params)]);
        expect(concurrent).toEqual(first);
        expect(first.commits).toHaveLength(2);
        expect(first.nextOffset).toBe(2);
        expect(first.commits[0]).toMatchObject({
            subject: 'merge 功能',
            author: 'Caxri Test',
            parents: [
                expect.stringMatching(/^[0-9a-f]{40}$/),
                expect.stringMatching(/^[0-9a-f]{40}$/),
            ],
        });
        expect(first.commits[0].decorations).toContain('HEAD -> main');
        expect(first.commits[0].authoredAt).toBeGreaterThan(0);

        const second = await git.commits({ ...params, offset: first.nextOffset! });
        expect(second.commits).toHaveLength(2);
        expect(second.nextOffset).toBe(4);
        const final = await git.commits({ ...params, offset: second.nextOffset! });
        expect(final.commits).toHaveLength(1);
        expect(final.nextOffset).toBeUndefined();
        expect(
            [...first.commits, ...second.commits, ...final.commits].map((item) => item.subject),
        ).toContain('功能提交');

        const subtree = await git.commits({ ...params, pageSize: 10, path: 'src' });
        expect(subtree.commits.map((item) => item.subject)).not.toContain('docs only');
        expect(subtree.commits.map((item) => item.subject)).not.toContain('main docs');
        expect(subtree.commits.map((item) => item.subject)).toEqual(
            expect.arrayContaining(['merge 功能', '功能提交', '初始提交']),
        );

        const details = await git.commitDetails({
            sessionId: session.id,
            repositoryId: repository.id,
            sha: first.commits[0].sha,
            path: 'src',
        });
        expect(details.commit.parents).toHaveLength(2);
        expect(details.files).toContainEqual({ path: 'src/feature.ts', status: 'added' });
        expect(details.filesTruncated).toBe(false);
        await expect(git.commits({ ...params, path: directory })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });

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
});
