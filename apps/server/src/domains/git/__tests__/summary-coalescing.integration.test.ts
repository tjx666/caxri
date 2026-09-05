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

function trackGitService(git: GitService): GitService {
    gitServices.push(git);
    return git;
}

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function createStatusFixture(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8');
    const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
    const session = database.createSession(database.createProject(directory).id, 'shell').session;
    const logger = new StructuredLogger(join(directory, '.logs'));
    const git = trackGitService(new GitService(new ProjectRootResolver(database), logger));
    return { database, directory, git, logger, session };
}

interface LoggedRecord {
    event: string;
    fields?: Record<string, unknown>;
}

async function loggedRecords(logger: StructuredLogger): Promise<LoggedRecord[]> {
    await logger.flush();
    return (await readFile(logger.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LoggedRecord);
}

async function gitSummaryRecords(
    logger: StructuredLogger,
): Promise<Array<Record<string, unknown>>> {
    return (await loggedRecords(logger))
        .filter((record) => record.event === 'git.summary')
        .map((record) => record.fields ?? {});
}

async function statusCommandCount(logger: StructuredLogger): Promise<number> {
    return (await loggedRecords(logger)).filter(
        (record) => record.event === 'git.command' && record.fields?.operation === 'status',
    ).length;
}

describe('GitService summary coalescing', () => {
    /**
     * Regression for #584: the coalescing key used to embed the caller's `refresh` nonce, so the Source Control
     * provider's forced refresh and the Renderer's plain read for the same Session ran as two parallel producers.
     */
    it('joins a plain read into an in-flight forced refresh instead of running a parallel producer', async () => {
        const { git, logger, session } = await createStatusFixture('caxri-git-join-force-');
        const [forced, plain] = await Promise.all([
            git.summary(session.id, 1, 'extension'),
            git.summary(session.id, 0, 'overview'),
        ]);
        expect(plain).toEqual(forced);
        expect(forced.repositories[0].files.map((file) => file.path)).toContain('tracked.txt');
        const records = await gitSummaryRecords(logger);
        expect(records.filter((record) => record.outcome === 'fresh')).toHaveLength(1);
        expect(records.find((record) => record.outcome === 'fresh')).toMatchObject({
            reason: 'refresh',
            requester: 'extension',
            statusFresh: 1,
        });
        expect(records.filter((record) => record.outcome === 'joined')).toEqual([
            { outcome: 'joined', requester: 'overview' },
        ]);
        expect(await statusCommandCount(logger)).toBe(1);
    });

    it('queues one trailing forced refresh behind an in-flight summary and shares it between forces', async () => {
        const { directory, git, logger, session } =
            await createStatusFixture('caxri-git-trailing-');
        const plain = git.summary(session.id);
        // Lands after the plain read started but before any forced snapshot may be taken.
        await writeFile(join(directory, 'late.txt'), 'late\n', 'utf8');
        const forcedA = git.summary(session.id, 1);
        const forcedB = git.summary(session.id, 2);
        const [, a, b] = await Promise.all([plain, forcedA, forcedB]);
        expect(b).toEqual(a);
        expect(a.repositories[0].files.map((file) => file.path)).toContain('late.txt');
        const records = await gitSummaryRecords(logger);
        const fresh = records.filter((record) => record.outcome === 'fresh');
        expect(fresh.map((record) => record.reason)).toEqual(['request', 'refresh']);
        expect(records.filter((record) => record.outcome === 'queued')).toEqual([
            { outcome: 'queued', requester: 'renderer', shared: false },
            { outcome: 'queued', requester: 'renderer', shared: true },
        ]);
        expect(await statusCommandCount(logger)).toBe(2);
    });

    /**
     * The forcing nonce is remembered as soon as the force is accepted, but its trailing run starts only after the
     * in-flight producer settles. A re-read that repeats the nonce during that gap must wait for the forced run, not
     * join the pre-click producer and render a snapshot that predates the user's action.
     */
    it('lets a same-nonce re-read wait for the queued forced run instead of joining the stale producer', async () => {
        const { directory, git, logger, session } = await createStatusFixture(
            'caxri-git-queued-reread-',
        );
        const plain = git.summary(session.id);
        await writeFile(join(directory, 'late.txt'), 'late\n', 'utf8');
        const forced = git.summary(session.id, 1, 'extension');
        const reread = git.summary(session.id, 1, 'extension');
        const [, a, b] = await Promise.all([plain, forced, reread]);
        expect(b).toEqual(a);
        expect(b.repositories[0].files.map((file) => file.path)).toContain('late.txt');
        const records = await gitSummaryRecords(logger);
        expect(records.filter((record) => record.outcome === 'joined')).toEqual([]);
        expect(records.filter((record) => record.outcome === 'queued')).toEqual([
            { outcome: 'queued', requester: 'extension', shared: false },
            { outcome: 'queued', requester: 'extension', shared: true },
        ]);
        expect(await statusCommandCount(logger)).toBe(2);
    });

    /**
     * Server close flushes every open aggregate, but a production still in flight settles afterwards and must take the
     * post-eviction flush path instead of reopening a window that nothing publishes.
     */
    it('publishes the aggregate of a production that settles after the service was closed', async () => {
        const { git, logger, session } = await createStatusFixture('caxri-git-close-race-');
        const inFlight = git.summary(session.id);
        await git.close();
        await inFlight;
        expect(
            (await loggedRecords(logger))
                .filter((record) => record.event === 'git.refresh_summary')
                .map((record) => record.fields?.refreshes),
        ).toEqual([1]);
    });

    /**
     * Eviction flushes the Session's refresh aggregate, but a production that was already in flight settles afterwards
     * and would otherwise reopen a window that only Server close publishes.
     */
    it('publishes the aggregate of a production that settles after its Session was evicted', async () => {
        const { git, logger, session } = await createStatusFixture('caxri-git-evict-race-');
        const inFlight = git.summary(session.id);
        git.evictSessions([session.id]);
        await inFlight;
        const aggregates = (await loggedRecords(logger)).filter(
            (record) => record.event === 'git.refresh_summary',
        );
        expect(aggregates.map((record) => record.fields?.refreshes)).toEqual([1]);
        await git.close();
        expect(
            (await loggedRecords(logger)).filter(
                (record) => record.event === 'git.refresh_summary',
            ),
        ).toHaveLength(1);
    });
});
