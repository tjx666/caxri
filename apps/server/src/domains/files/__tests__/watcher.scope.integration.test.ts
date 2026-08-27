import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

function pendingScope(service: FileService) {
    return Reflect.get(service, 'watcher') as {
        pendingScope?: { sessionId: string; workbenchProjectId: string };
    };
}

describe('File watcher scopes', () => {
    it('separates pending batches when Sessions sharing a Project switch source', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-shared-project-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const changedPath = join(root, 'changed.txt');
        const secondPath = join(root, 'second.txt');
        await writeFile(changedPath, 'before', 'utf8');
        await writeFile(secondPath, 'before', 'utf8');
        const [canonicalChangedPath, canonicalSecondPath] = await Promise.all([
            realpath(changedPath),
            realpath(secondPath),
        ]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell').session;
        const second = database.createSession(project.id, 'codex').session;
        const events: ServerEvent[] = [];
        let callback: Parameters<typeof parcelWatcher.subscribe>[1] | undefined;
        let subscribeCalls = 0;
        const subscribe: typeof parcelWatcher.subscribe = (_root, onEvents) => {
            subscribeCalls += 1;
            callback = onEvents;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        };
        const service = new FileService(
            database,
            (event) => {
                events.push(event);
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { subscribe },
        );

        await service.watchSession(first.id);
        expect(callback).toBeDefined();
        callback!(null, [{ path: canonicalChangedPath, type: 'update' }]);
        await expect
            .poll(() => pendingScope(service).pendingScope, { interval: 1 })
            .toEqual({ sessionId: first.id, workbenchProjectId: project.id });
        await service.watchSession(second.id);
        callback!(null, [{ path: canonicalSecondPath, type: 'update' }]);

        await expect
            .poll(() => events.filter((event) => event.event === 'files.changed'))
            .toHaveLength(2);
        expect(subscribeCalls).toBe(1);
        const batches = events.filter((event) => event.event === 'files.changed');
        expect(batches).toEqual([
            {
                event: 'files.changed',
                payload: {
                    sessionId: first.id,
                    workbenchProjectId: project.id,
                    changes: [{ path: canonicalChangedPath, kind: 'update' }],
                    overflow: false,
                },
            },
            {
                event: 'files.changed',
                payload: {
                    sessionId: second.id,
                    workbenchProjectId: project.id,
                    changes: [{ path: canonicalSecondPath, kind: 'update' }],
                    overflow: false,
                },
            },
        ]);
        await service.close();
        database.close();
    });

    it('flushes a pending batch before a cross-Project replacement and fences stale callbacks', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-cross-project-'));
        temporaryDirectories.push(directory);
        const firstRoot = join(directory, 'first');
        const secondRoot = join(directory, 'second');
        await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
        const firstPath = join(firstRoot, 'first.txt');
        await writeFile(firstPath, 'before', 'utf8');
        const [canonicalFirstRoot, canonicalFirstPath] = await Promise.all([
            realpath(firstRoot),
            realpath(firstPath),
        ]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const firstProject = database.createProject(firstRoot);
        const secondProject = database.createProject(secondRoot);
        const first = database.createSession(firstProject.id, 'shell').session;
        const second = database.createSession(secondProject.id, 'codex').session;
        const events: ServerEvent[] = [];
        const callbacks: Array<Parameters<typeof parcelWatcher.subscribe>[1]> = [];
        const subscribe: typeof parcelWatcher.subscribe = (_root, onEvents) => {
            callbacks.push(onEvents);
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        };
        const service = new FileService(
            database,
            (event) => {
                events.push(event);
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { subscribe },
        );

        await service.watchSession(first.id);
        expect(callbacks[0]).toBeDefined();
        callbacks[0](null, [{ path: canonicalFirstPath, type: 'update' }]);
        await expect
            .poll(() => pendingScope(service).pendingScope, { interval: 1 })
            .toEqual({ sessionId: first.id, workbenchProjectId: firstProject.id });
        await service.watchSession(second.id);
        callbacks[0]?.(null, [{ path: join(canonicalFirstRoot, 'stale.txt'), type: 'create' }]);

        await expect
            .poll(() => events.filter((event) => event.event === 'files.changed'))
            .toHaveLength(1);
        expect(callbacks).toHaveLength(2);
        expect(events).toContainEqual({
            event: 'files.changed',
            payload: {
                sessionId: first.id,
                workbenchProjectId: firstProject.id,
                changes: [{ path: canonicalFirstPath, kind: 'update' }],
                overflow: false,
            },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events).toHaveLength(1);
        await service.close();
        database.close();
    });
});
