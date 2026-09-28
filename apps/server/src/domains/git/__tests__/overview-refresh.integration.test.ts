import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const directories: string[] = [];
const services: GitService[] = [];
const databases: CaxriDatabase[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    await Promise.all(services.map((service) => service.close()));
    services.length = 0;
    for (const database of databases) database.close();
    databases.length = 0;
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-git-overview-'));
    directories.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Fixture User'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'old\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const support = await mkdtemp(join(tmpdir(), 'caxri-git-overview-support-'));
    directories.push(support);
    const database = new CaxriDatabase(join(support, 'test.db'));
    databases.push(database);
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const logger = new StructuredLogger(join(support, 'logs'));
    loggers.push(logger);
    const git = new GitService(new ProjectRootResolver(database), logger);
    services.push(git);
    return { git, root, session };
}

describe('Git overview refresh', () => {
    /**
     * No Project file watcher covers this root — the same position as every Session other than the selected one — so a
     * plain working-tree write never advances its status generation. A cached read keeps answering from the old
     * snapshot; only a refreshing read sees the write (issue #859).
     */
    it('re-reads an unwatched working tree only when asked to refresh', async () => {
        const { git, root, session } = await fixture();
        const clean = await git.overview(session.id);
        expect(clean.repositories[0].changedFileCount).toBe(0);

        await writeFile(join(root, 'tracked.txt'), 'edited by an Agent\n');
        await writeFile(join(root, 'untracked.txt'), 'new\n');

        const cached = await git.overview(session.id);
        expect(cached.repositories[0].changedFileCount).toBe(0);

        const refreshed = await git.overview(session.id, true);
        expect(refreshed.repositories[0]).not.toHaveProperty('files');
        expect(refreshed.repositories[0].changedFileCount).toBe(2);
        expect(refreshed.repositories[0].generation).toBeGreaterThan(
            cached.repositories[0].generation,
        );

        const afterRefresh = await git.overview(session.id);
        expect(afterRefresh.repositories[0].changedFileCount).toBe(2);
    });
});
