import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { ProjectStatusSummaryErrorMessage } from 'caxri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const loggers: StructuredLogger[] = [];

async function cleanupFixtures(): Promise<void> {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    /**
     * Pending log writes recreate missing directories, so drain them after producers stop and before removal.
     */
    const loggersToFlush = [...loggers];
    loggers.length = 0;
    await Promise.all(loggersToFlush.map((logger) => logger.flush()));
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
}

afterEach(cleanupFixtures);

/**
 * A Project whose root exists but is not a repository root, which is the shape that used to re-derive forever. Counts
 * every Git spawn, successful or failed, so a suppressed rediscovery is provable rather than inferred from the
 * summary.
 */
async function createFixture(prefix: string) {
    const container = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(container);
    const root = join(container, 'project');
    await mkdir(root);
    const database = new CaxriDatabase(join(container, '.caxri-test.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const logger = new StructuredLogger(join(container, '.logs'));
    loggers.push(logger);
    const write = vi.spyOn(logger, 'write');
    const git = new GitService(new ProjectRootResolver(database), logger);
    gitServices.push(git);
    return {
        container,
        database,
        git,
        logger,
        root,
        session,
        /**
         * Per-summary Git command attribution from the `git.summary` producer boundary. Counting `git.command` records
         * directly would also pick up background metadata work that is not part of discovery. A repeated result is
         * written at `debug` (#604), so select producer records by outcome rather than by level; one that also ran no
         * command is not written at all and appears only in `refreshAggregates`.
         */
        summaryCommandCounts: () =>
            write.mock.calls
                .filter((call) => call[1] === 'git.summary')
                .map(
                    (call) =>
                        (call[2] as { fields: { commandCount: number; outcome: string } }).fields,
                )
                .filter((fields) => fields.outcome === 'fresh')
                .map((fields) => fields.commandCount),
        refreshAggregates: () =>
            write.mock.calls
                .filter((call) => call[1] === 'git.refresh_summary')
                .map((call) => (call[2] as { fields: Record<string, unknown> }).fields),
    };
}

describe('Git discovery failure', () => {
    it('waits for the fixture log drain before removing its directory', async () => {
        const fixture = await createFixture('caxri-git-log-drain-');
        await fixture.git.summary(fixture.session.id);
        fixture.database.close();
        const gate = Promise.withResolvers<void>();
        const drain = fixture.logger.flush.bind(fixture.logger);
        const flush = vi.spyOn(fixture.logger, 'flush').mockImplementationOnce(async () => {
            await gate.promise;
            await drain();
        });
        const cleanup = Promise.allSettled([cleanupFixtures()]);
        try {
            await vi.waitFor(() => expect(flush).toHaveBeenCalled());
            await expect(stat(fixture.container)).resolves.toBeDefined();
            gate.resolve();
            await expect(cleanup).resolves.toEqual([{ status: 'fulfilled', value: undefined }]);
            await expect(stat(fixture.container)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            gate.resolve();
            await cleanup;
            await drain();
            await rm(fixture.container, { recursive: true, force: true });
        }
    });

    it('stops rediscovering a Project root that is not a repository', async () => {
        const fixture = await createFixture('caxri-git-nonrepo-');

        const discovered = await fixture.git.summary(fixture.session.id);
        const replayed = await fixture.git.summary(fixture.session.id);
        await fixture.git.summary(fixture.session.id);

        expect(discovered).toMatchObject({ isRepository: false });
        // Replays run no Git command and repeat the same result, so only the aggregate counts them.
        const [first, ...repeats] = fixture.summaryCommandCounts();
        expect(first).toBeGreaterThan(0);
        expect(repeats).toEqual([]);
        await fixture.git.close();
        expect(fixture.refreshAggregates()).toEqual([
            expect.objectContaining({ refreshes: 3, commandCount: first }),
        ]);
        fixture.database.close();
        /**
         * `GitSummary.error` is a public Extension API field, and `ProjectStatusSummaryErrorMessage` exists so
         * extensions can match its wording. A summary served from the cache must therefore be indistinguishable from
         * the one that ran discovery, down to the translated message.
         */
        expect(replayed).toEqual(discovered);
        expect(discovered.error).toBe(ProjectStatusSummaryErrorMessage.missingGitRepository);
    });

    it('rediscovers as soon as the root becomes a repository again', async () => {
        const fixture = await createFixture('caxri-git-restored-');
        await fixture.git.summary(fixture.session.id);

        await execFileAsync('git', ['init', '-b', 'main'], { cwd: fixture.root });

        // No refresh nonce and no eviction: re-probing `.git` on the cache hit is what clears the entry.
        await expect(fixture.git.summary(fixture.session.id)).resolves.toMatchObject({
            isRepository: true,
        });
        expect(fixture.summaryCommandCounts().at(-1)).toBeGreaterThan(0);
        fixture.database.close();
    });

    it('retries a transient failure on a root that still carries .git', async () => {
        const fixture = await createFixture('caxri-git-transient-');
        // A `.git` file whose gitdir does not exist fails discovery without making the root structurally hopeless.
        await writeFile(join(fixture.root, '.git'), 'gitdir: ./nowhere\n', 'utf8');

        await expect(fixture.git.summary(fixture.session.id)).resolves.toMatchObject({
            isRepository: false,
            error: 'The Git operation failed. Open Logs for details.',
        });
        await fixture.git.summary(fixture.session.id);

        // Both attempts still spawn: a root that keeps `.git` may recover on the very next request.
        expect(fixture.summaryCommandCounts().every((count) => count > 0)).toBe(true);
        fixture.database.close();
    });

    /**
     * The issue reported this shape as the one that re-derived forever. It never did: the Session path resolver rejects
     * on `lstat` before discovery can spawn anything, so the guard here is that the behavior stays that way.
     */
    it('rejects without running discovery when the Project root is gone', async () => {
        const fixture = await createFixture('caxri-git-missing-');
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: fixture.root });
        await fixture.git.summary(fixture.session.id);
        await rename(fixture.root, `${fixture.root}-moved`);
        const baseline = fixture.summaryCommandCounts().length;

        await expect(fixture.git.summary(fixture.session.id)).rejects.toThrow(/ENOENT/);
        await expect(fixture.git.summary(fixture.session.id)).rejects.toThrow(/ENOENT/);

        // Discovery never reached the producer boundary, which is where Git is spawned.
        expect(fixture.summaryCommandCounts()).toHaveLength(baseline);
        fixture.database.close();
    });
});
