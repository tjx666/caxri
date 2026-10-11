import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

function trackGitService(git: GitService): GitService {
    gitServices.push(git);
    return git;
}

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
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

async function createStatusFixture(
    prefix: string,
    options: { emit?: (event: ServerEvent) => void } = {},
) {
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
    const logger = createLogger(join(directory, '.logs'));
    const git = trackGitService(
        new GitService(new ProjectRootResolver(database), logger, { emit: options.emit }),
    );
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
    it('refreshes snapshots retained by a sibling Session when a watcher reattaches', async () => {
        const { database, directory, git, session } =
            await createStatusFixture('caxri-git-reattach-');
        const sibling = database.createSession(session.projectId, 'shell').session;
        await git.summary(session.id);
        await git.summary(sibling.id);
        git.evictSessions([session.id]);
        await writeFile(join(directory, 'while-inactive.txt'), '');
        const stale = await git.summary(sibling.id);
        expect(stale.repositories[0].files.map((file) => file.path)).not.toContain(
            'while-inactive.txt',
        );
        await git.observeWatcherAttached(session.id);
        const updated = await git.summary(session.id);
        expect(updated.repositories[0].files.map((file) => file.path)).toContain(
            'while-inactive.txt',
        );
        const siblingUpdated = await git.summary(sibling.id);
        expect(siblingUpdated.repositories[0].generation).toBe(updated.repositories[0].generation);
    });

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

    /**
     * Regression for #1321: a manual "Refresh Git" (or Sync/Discard) forces `summary()` to re-read status, but that
     * alone used to notify no one: an already open diff document, and the review-comment outdated check that piggybacks
     * on it, stayed silently dependent on the passive file watcher's own delivery timing. A forced summary must
     * schedule the same `git.changed` invalidation a watcher-observed write does, so a user-initiated refresh reliably
     * re-evaluates every open diff regardless of watcher latency.
     */
    it('emits git.changed for a forced summary refresh even without an observed working-tree change', async () => {
        const events: ServerEvent[] = [];
        const { git, session } = await createStatusFixture('caxri-git-forced-changed-', {
            emit: (event) => events.push(event),
        });
        // Registers the Session's repository projection with the change tracker.
        await git.summary(session.id);
        expect(events).toHaveLength(0);
        // A forced refresh with no `observeFilesChanged`/watcher activity in between.
        await git.summary(session.id, 1, 'extension');
        await vi.waitFor(() =>
            expect(events.some((event) => event.event === 'git.changed')).toBe(true),
        );
        const changed = events.find((event) => event.event === 'git.changed');
        expect(changed?.payload).toMatchObject({ scope: 'status', sessionIds: [session.id] });
    });
});
