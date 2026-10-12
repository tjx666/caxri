import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { mapWithConcurrency, StructuredLogger } from '@caxri/system';
import { afterEach, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { WatchHub } from '../../watch';
import { FileService } from '../service';

const cleanup: Array<() => Promise<void>> = [];
async function disposeFixtures(): Promise<void> {
    const disposals = cleanup.toReversed();
    cleanup.length = 0;
    // Resources are dependent: stop observation before closing its database and removing its fixture.
    // eslint-disable-next-line no-await-in-loop -- preserve resource ownership order
    for (const dispose of disposals) await dispose();
}
afterEach(disposeFixtures);

async function fixture(options: { pollIntervalMs?: number } = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-external-links-'));
    cleanup.push(() => rm(temporary, { recursive: true, force: true }));
    const directory = await realpath(temporary);
    const root = join(directory, 'project');
    const target = join(directory, 'external.txt');
    await mkdir(root);
    await writeFile(target, 'before');
    const entry = join(root, 'linked.txt');
    await symlink(target, entry);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    cleanup.push(() => {
        database.close();
        return Promise.resolve();
    });
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const events: ServerEvent[] = [];
    const watchHub = new WatchHub({
        subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    });
    cleanup.push(() => watchHub.close());
    const logger = new StructuredLogger(join(directory, 'logs'));
    cleanup.push(() => logger.flush());
    const service = new FileService(
        database,
        (event) => events.push(event),
        logger,
        () => 1024,
        { watchHub, pollIntervalMs: options.pollIntervalMs ?? 30 },
    );
    cleanup.push(() => service.close());
    await service.watchSession(session.id);
    const changes = () =>
        events.flatMap((event) => (event.event === 'files.changed' ? event.payload.changes : []));
    return {
        directory,
        root,
        target,
        entry,
        database,
        session,
        events,
        service,
        watchHub,
        changes,
    };
}

it('keeps a recreated external target classified as create when its first write changes again inside one batch', async () => {
    vi.useFakeTimers();
    try {
        const { target, entry, service, session, changes, events, watchHub } = await fixture({
            pollIntervalMs: 60_000,
        });
        const registrations = vi.spyOn(watchHub, 'registerPoller');
        await service.read(session.id, entry);
        expect(registrations).toHaveBeenCalledOnce();
        const pollOnce = registrations.mock.calls[0][0].pollOnce;

        await unlink(target);
        await pollOnce();
        await vi.advanceTimersByTimeAsync(75);
        expect(changes()).toContainEqual({ path: entry, kind: 'delete' });
        events.length = 0;

        await writeFile(target, '');
        await pollOnce();
        await writeFile(target, 'recreated');
        await pollOnce();
        expect(changes()).toEqual([]);
        await vi.advanceTimersByTimeAsync(75);
        expect(changes()).toContainEqual({ path: entry, kind: 'create' });
    } finally {
        try {
            await disposeFixtures();
        } finally {
            vi.useRealTimers();
        }
    }
});

it('reports direct external target edits under the workspace file identity while native watching works', async () => {
    const { service, session, entry, target, changes } = await fixture();
    expect((await service.read(session.id, entry)).path).toBe(entry);
    await writeFile(target, 'after external edit');
    await expect.poll(changes, { timeout: 2000 }).toContainEqual({ path: entry, kind: 'update' });
    expect((await service.read(session.id, entry)).content).toBe('after external edit');
});

it('invalidates expanded external directories after direct membership changes without traversing links', async () => {
    const { directory, root, service, session, changes, events } = await fixture();
    const target = join(directory, 'outside');
    const entry = join(root, 'linked-directory');
    await mkdir(target);
    await symlink(target, entry);
    await symlink(target, join(target, 'loop'));
    await service.list(session.id, entry);
    await writeFile(join(target, 'added.txt'), 'fixture');
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'update' });
    expect((await service.list(session.id, entry)).map((file) => file.name)).toContain('added.txt');
    events.length = 0;
    await unlink(join(target, 'added.txt'));
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'update' });
    expect((await service.list(session.id, entry)).map((file) => file.name)).not.toContain(
        'added.txt',
    );
});

it('maps multiple aliases independently and releases the poller on same-Project Session switches and close', async () => {
    const { root, target, entry, service, session, database, watchHub, changes } = await fixture();
    const alias = join(root, 'alias.txt');
    await symlink(target, alias);
    await Promise.all([service.read(session.id, entry), service.read(session.id, alias)]);
    expect(watchHub.snapshot().polling).toBe(1);
    await writeFile(target, 'both aliases change');
    await expect.poll(changes).toEqual(
        expect.arrayContaining([
            { path: entry, kind: 'update' },
            { path: alias, kind: 'update' },
        ]),
    );
    const second = database.createSession(session.projectId, 'shell').session;
    await service.watchSession(second.id);
    expect(watchHub.snapshot().polling).toBe(0);
    await service.read(second.id, alias);
    expect(watchHub.snapshot().polling).toBe(1);
    await service.watchSession();
    expect(watchHub.snapshot().registrations).toBe(0);
});

it('recovers deleted targets and follows a retargeted workspace entry without granting arbitrary outside paths', async () => {
    const { directory, root, target, entry, service, session, changes, events } = await fixture();
    await expect(service.read(session.id, target)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await service.read(session.id, entry);
    await unlink(target);
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'delete' });
    events.length = 0;
    await writeFile(target, 'recreated');
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'create' });
    events.length = 0;
    const replacement = join(directory, 'replacement.txt');
    const replacementEntry = join(root, 'replacement-link.txt');
    await writeFile(replacement, 'replacement');
    await symlink(replacement, replacementEntry);
    await rename(replacementEntry, entry);
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'update' });
    expect((await service.read(session.id, entry)).content).toBe('replacement');
});

it('reports explicit workspace link removal and recreation as delete then create', async () => {
    const { target, entry, service, session, changes, events } = await fixture();
    await service.read(session.id, entry);
    await unlink(entry);
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'delete' });
    events.length = 0;
    await symlink(target, entry);
    await expect.poll(changes).toContainEqual({ path: entry, kind: 'create' });
    expect((await service.read(session.id, entry)).content).toBe('before');
});

it('rejects unresolved link cycles without registering external observation', async () => {
    const { root, service, session, watchHub } = await fixture();
    const cycle = join(root, 'cycle');
    await symlink('cycle', cycle);
    await expect(service.read(session.id, cycle)).rejects.toMatchObject({ code: 'ELOOP' });
    expect(watchHub.snapshot().polling).toBe(0);
});

it('requests scope reconciliation instead of silently dropping notifications at the observation cap', async () => {
    const { root, target, service, session, events, watchHub } = await fixture();
    const aliases = Array.from({ length: 513 }, (_, index) => join(root, `alias-${index}.txt`));
    await mapWithConcurrency(aliases, 8, async (alias) => {
        await symlink(target, alias);
        await service.read(session.id, alias);
    });
    expect(watchHub.snapshot().polling).toBe(1);
    await writeFile(target, 'all open aliases need reconciliation');
    await expect
        .poll(() =>
            events.some((event) => event.event === 'files.changed' && event.payload.overflow),
        )
        .toBe(true);
});
