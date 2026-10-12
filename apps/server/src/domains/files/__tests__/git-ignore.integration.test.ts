import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { WatchHub } from '../../watch';
import type { GitIgnoreDecorator } from '../listing';
import { FileService } from '../service';
import { WatcherService } from '../watcher';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

afterEach(async () => {
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git ignored file decorations', () => {
    it('observes registered Git metadata without traversing the .git directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-git-rule-watch-'));
        temporaryDirectories.push(root);
        const rulePath = join(root, '.git', 'info', 'exclude');
        await mkdir(join(root, '.git', 'info'), { recursive: true });
        await writeFile(rulePath, 'before\n', 'utf8');
        const events: ServerEvent[] = [];
        const watcher = new WatcherService(
            () => Promise.resolve({ path: root, root }),
            (event) => {
                events.push(event);
            },
            createLogger(join(root, 'logs')),
            {
                pollIntervalMs: 20,
                subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) }),
            },
        );
        await watcher.watchSession({ sessionId: 'session', workbenchProjectId: 'project' });
        await watcher.noteGitIgnoreRulePaths('session', [rulePath]);
        await writeFile(rulePath, 'after\n', 'utf8');

        await expect
            .poll(() =>
                events.some(
                    (event) =>
                        event.event === 'files.changed' &&
                        'gitIgnoreRulesChanged' in event.payload &&
                        event.payload.gitIgnoreRulesChanged === true,
                ),
            )
            .toBe(true);
        await watcher.close();
    });

    it('detects a working-tree .gitignore from the event stream without pre-registration or a rule poller', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-git-rule-events-'));
        temporaryDirectories.push(root);
        const rulePath = join(root, '.gitignore');
        await writeFile(rulePath, 'before\n', 'utf8');
        type SubscribeCallback = Parameters<typeof parcelWatcher.subscribe>[1];
        const callbacks: SubscribeCallback[] = [];
        const subscribe = ((_root: string, callback: SubscribeCallback) => {
            callbacks.push(callback);
            return Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) });
        }) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const events: ServerEvent[] = [];
        const watcher = new WatcherService(
            () => Promise.resolve({ path: root, root }),
            (event) => {
                events.push(event);
            },
            createLogger(join(root, 'logs')),
            { watchHub },
        );
        await watcher.watchSession({ sessionId: 'session', workbenchProjectId: 'project' });

        // Working-tree .gitignore files ride the normal watch event stream; no dedicated rule poller may be registered.
        expect(watchHub.snapshot().entries.some((entry) => entry.label === 'files-git-rules')).toBe(
            false,
        );

        await writeFile(rulePath, 'after\n', 'utf8');
        callbacks[0]?.(null, [{ type: 'update', path: rulePath }]);

        await expect
            .poll(() =>
                events.some(
                    (event) =>
                        event.event === 'files.changed' &&
                        'gitIgnoreRulesChanged' in event.payload &&
                        event.payload.gitIgnoreRulesChanged === true,
                ),
            )
            .toBe(true);
        await watcher.close();
        await watchHub.close();
    });

    it('detects in-root rule files in unlisted directories while degraded to polling', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-git-rule-poll-fallback-'));
        temporaryDirectories.push(root);
        // A rule file inside a subdirectory the user never expanded: absent from the polled directory signatures.
        const rulePath = join(root, 'packages', 'foo', '.gitignore');
        await mkdir(join(root, 'packages', 'foo'), { recursive: true });
        await writeFile(rulePath, 'before\n', 'utf8');
        const events: ServerEvent[] = [];
        const watcher = new WatcherService(
            () => Promise.resolve({ path: root, root }),
            (event) => {
                events.push(event);
            },
            createLogger(join(root, 'logs')),
            {
                pollIntervalMs: 20,
                subscribe: () => Promise.reject(new Error('native backend unavailable')),
            },
        );
        await watcher.watchSession({ sessionId: 'session', workbenchProjectId: 'project' });
        await watcher.noteGitIgnoreRulePaths('session', [rulePath]);
        await writeFile(rulePath, 'after\n', 'utf8');

        await expect
            .poll(() =>
                events.some(
                    (event) =>
                        event.event === 'files.changed' &&
                        'gitIgnoreRulesChanged' in event.payload &&
                        event.payload.gitIgnoreRulesChanged === true,
                ),
            )
            .toBe(true);
        await watcher.close();
    });

    it('decorates visible ignored entries with one directory batch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-ignore-decoration-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await Promise.all([
            mkdir(join(root, 'dist'), { recursive: true }),
            mkdir(join(root, 'node_modules'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(root, 'ignored.log'), 'ignored', 'utf8'),
            writeFile(join(root, 'tracked.ts'), 'tracked', 'utf8'),
        ]);
        const canonicalRoot = await realpath(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const decorateGitIgnored = vi.fn<GitIgnoreDecorator>().mockResolvedValue({
            ignoredNames: new Set(['ignored.log', 'node_modules']),
            rulePaths: [],
        });
        const options = {
            decorateGitIgnored,
            fileTreeExcludes: () => ({ '**/dist': true }),
        };
        const service = new FileService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
            options,
        );

        const entries = await service.list(session.id);

        expect(entries).toEqual([
            {
                gitIgnored: true,
                kind: 'directory',
                name: 'node_modules',
                path: join(canonicalRoot, 'node_modules'),
            },
            {
                gitIgnored: true,
                kind: 'file',
                name: 'ignored.log',
                path: join(canonicalRoot, 'ignored.log'),
                size: 7,
            },
            {
                kind: 'file',
                name: 'tracked.ts',
                path: join(canonicalRoot, 'tracked.ts'),
                size: 7,
            },
        ]);
        expect(decorateGitIgnored).toHaveBeenCalledOnce();
        expect(decorateGitIgnored).toHaveBeenCalledWith(
            session.id,
            canonicalRoot,
            expect.arrayContaining(['ignored.log', 'node_modules', 'tracked.ts']),
        );
        expect(decorateGitIgnored.mock.calls[0]?.[2]).toHaveLength(3);
        database.close();
    });

    it('keeps non-Git directories usable when decoration is unavailable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-non-git-decoration-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        await writeFile(join(root, 'visible.ts'), 'visible', 'utf8');
        const canonicalRoot = await realpath(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const decorateGitIgnored = vi
            .fn<GitIgnoreDecorator>()
            .mockRejectedValue(new Error('not a Git repository'));
        const options = { decorateGitIgnored };
        const logger = createLogger(join(directory, 'logs'));
        const service = new FileService(
            database,
            () => {},
            logger,
            () => 1024,
            options,
        );

        await expect(service.list(session.id)).resolves.toEqual(
            expect.arrayContaining([
                {
                    kind: 'file',
                    name: 'visible.ts',
                    path: join(canonicalRoot, 'visible.ts'),
                    size: 7,
                },
            ]),
        );
        await logger.flush();
        database.close();
    });
});
