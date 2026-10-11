import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const databases: CaxriDatabase[] = [];

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    const databasesToClose = [...databases];
    databases.length = 0;
    for (const database of databasesToClose) database.close();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

interface LoggedRecord {
    event: string;
    fields?: Record<string, unknown>;
    level: string;
}

async function productionRecords(logger: StructuredLogger): Promise<LoggedRecord[]> {
    await logger.flush();
    return (await readFile(logger.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LoggedRecord);
}

/**
 * Production sinks run at `info`. Before #604 every refresh wrote one `git.summary` record whether or not the result
 * changed, and on a real profile that single event filled almost half of a 5MB generation. The contract now: a refresh
 * whose result repeats the previous one for the Session leaves no `info` record, a real state change still does, and
 * one `git.refresh_summary` per Session restores the refresh count, change count, and worst-case duration.
 */
describe('git.summary production log volume', () => {
    it('records unchanged refreshes once per window and every state change individually', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-git-summary-volume-'));
        temporaryDirectories.push(root);
        // The database and log live beside the repository, not inside it, so their growth never shows up as a change.
        const directory = join(root, 'repo');
        await mkdir(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'tracked\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        const database = new CaxriDatabase(join(root, 'caxri-test.db'));
        databases.push(database);
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = new StructuredLogger(join(root, 'logs'), 'server-core', 'info');
        const git = new GitService(new ProjectRootResolver(database), logger);
        gitServices.push(git);

        const unchangedRefreshes = 8;
        for (let nonce = 1; nonce <= unchangedRefreshes; nonce += 1) {
            // Sequential on purpose: each forced refresh must observe the same unchanged tree as the one before it.
            // eslint-disable-next-line no-await-in-loop -- see above
            await git.summary(session.id, nonce);
        }
        await writeFile(join(directory, 'tracked.txt'), 'edited\n', 'utf8');
        const changed = await git.summary(session.id, unchangedRefreshes + 1);
        expect(changed.repositories[0]?.changedFileCount).toBe(1);
        await git.close();

        const records = await productionRecords(logger);
        const summaries = records.filter((record) => record.event === 'git.summary');
        expect(summaries.map((record) => record.level)).toEqual(['info', 'info']);
        expect(summaries.map((record) => record.fields?.changed)).toEqual([true, true]);
        const aggregate = records.filter((record) => record.event === 'git.refresh_summary');
        expect(aggregate).toHaveLength(1);
        expect(aggregate[0]?.fields).toMatchObject({
            sessionId: session.id,
            refreshes: unchangedRefreshes + 1,
            changed: 2,
            repeated: unchangedRefreshes - 1,
            reasonRefresh: unchangedRefreshes + 1,
            requesterRenderer: unchangedRefreshes + 1,
        });
        expect(aggregate[0]?.fields?.maxDurationMs).toEqual(expect.any(Number));
        expect(aggregate[0]?.fields?.commandCount).toBeGreaterThan(unchangedRefreshes);
        // The aggregate carries counts and durations only; repository private data stays out of it.
        expect(JSON.stringify(aggregate[0])).not.toContain(directory);
        expect(JSON.stringify(aggregate[0])).not.toContain('tracked.txt');
    });
});
