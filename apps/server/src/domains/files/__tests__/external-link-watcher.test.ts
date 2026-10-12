import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { WatchHub } from '../../watch';
import { ExternalLinkWatcher } from '../external-link-watcher';

afterEach(() => {
    vi.useRealTimers();
});

it('bounds and coalesces an initial external target probe', async () => {
    vi.useFakeTimers();
    const root = '/project';
    const target = '/external/target.txt';
    const release = Promise.withResolvers<string>();
    const fingerprint = vi.fn(() => release.promise);
    const hub = new WatchHub();
    const watcher = new ExternalLinkWatcher(
        () => Promise.reject(new Error('initial note must not resolve the path again')),
        hub,
        60_000,
        vi.fn(),
        vi.fn(),
        fingerprint,
    );
    try {
        await watcher.reset({ sessionId: 'session', workbenchProjectId: 'project' });
        const first = watcher.note('session', {
            root,
            path: target,
            workspacePath: '/project/first.txt',
        });
        const alias = watcher.note('session', {
            root,
            path: target,
            workspacePath: '/project/alias.txt',
        });
        const duplicate = watcher.note('session', {
            root,
            path: target,
            workspacePath: '/project/first.txt',
        });
        const firstResult = expect(first).rejects.toThrow('External link metadata probe timed out');
        const aliasResult = expect(alias).rejects.toThrow('External link metadata probe timed out');
        const duplicateResult = expect(duplicate).rejects.toThrow(
            'External link metadata probe timed out',
        );
        await vi.advanceTimersByTimeAsync(2_000);

        await Promise.all([firstResult, aliasResult, duplicateResult]);
        expect(fingerprint).toHaveBeenCalledOnce();
    } finally {
        release.resolve(`${target}:snapshot`);
        await watcher.reset();
        await hub.close();
    }
});

it('fences an external target poll that resolves after a same-Project Session switch', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-link-generation-'));
    const directory = await realpath(temporary);
    const target = join(directory, 'target.txt');
    await writeFile(target, 'before');
    const root = join(directory, 'project');
    const workspacePath = join(root, 'link.txt');
    const resolved = { root, path: target, workspacePath };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<typeof resolved>();
    const hub = new WatchHub();
    const registrations = vi.spyOn(hub, 'registerPoller');
    const changed = vi.fn<ConstructorParameters<typeof ExternalLinkWatcher>[3]>();
    const watcher = new ExternalLinkWatcher(
        () => {
            entered.resolve();
            return release.promise;
        },
        hub,
        60_000,
        changed,
        () => {},
    );
    try {
        await watcher.reset({ sessionId: 'first', workbenchProjectId: 'project' });
        await watcher.note('first', resolved);
        await writeFile(target, 'after');
        expect(registrations).toHaveBeenCalledOnce();
        const [registration] = registrations.mock.calls[0];
        const pending = registration.pollOnce();
        await entered.promise;
        await watcher.reset({ sessionId: 'second', workbenchProjectId: 'project' });
        release.resolve(resolved);
        await pending;
        expect(changed).not.toHaveBeenCalled();
        expect(hub.snapshot().registrations).toBe(0);
    } finally {
        release.resolve(resolved);
        await watcher.reset();
        await hub.close();
        await rm(temporary, { recursive: true, force: true });
    }
});

it('lets a new scope re-authorize an entry while the old scope probe is still hung', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-link-reset-'));
    const directory = await realpath(temporary);
    const target = join(directory, 'target.txt');
    await writeFile(target, 'before');
    const root = join(directory, 'project');
    const workspacePath = join(root, 'link.txt');
    const resolved = { root, path: target, workspacePath };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<typeof resolved>();
    const hub = new WatchHub();
    const watcher = new ExternalLinkWatcher(
        () => {
            entered.resolve();
            return release.promise;
        },
        hub,
        60_000,
        vi.fn(),
        () => {},
        () => Promise.resolve(`${target}:snapshot`),
    );
    const registrations = vi.spyOn(hub, 'registerPoller');
    try {
        await watcher.reset({ sessionId: 'first', workbenchProjectId: 'project' });
        await watcher.note('first', resolved);
        const [registration] = registrations.mock.calls[0];
        const pending = registration.pollOnce();
        await entered.promise;
        await watcher.reset({ sessionId: 'second', workbenchProjectId: 'project' });

        await expect(watcher.note('second', resolved)).resolves.toBeUndefined();
        release.resolve(resolved);
        await pending;
    } finally {
        release.resolve(resolved);
        await watcher.reset();
        await hub.close();
        await rm(temporary, { recursive: true, force: true });
    }
});

it('reports an inaccessible alias without starving the rest of a polling batch', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-link-errors-'));
    const target = join(await realpath(temporary), 'target.txt');
    await writeFile(target, 'before');
    const root = join(temporary, 'project');
    const entries = Array.from({ length: 8 }, (_, index) => join(root, `alias-${index}.txt`));
    const denied = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    const hub = new WatchHub();
    const registrations = vi.spyOn(hub, 'registerPoller');
    const changed = vi.fn<ConstructorParameters<typeof ExternalLinkWatcher>[3]>();
    const watcher = new ExternalLinkWatcher(
        (_sessionId, entry) =>
            entry === entries[0]
                ? Promise.reject(denied)
                : Promise.resolve({ root, path: target, workspacePath: entry }),
        hub,
        60_000,
        changed,
        () => {},
    );
    try {
        await watcher.reset({ sessionId: 'session', workbenchProjectId: 'project' });
        await Promise.all(
            entries.map((workspacePath) =>
                watcher.note('session', {
                    root,
                    path: target,
                    workspacePath,
                }),
            ),
        );
        await writeFile(target, 'after');
        const [registration] = registrations.mock.calls[0];
        await expect(registration.pollOnce()).rejects.toBe(denied);
        expect(changed).toHaveBeenCalledTimes(7);
        expect(changed.mock.calls.map(([, change]) => change.path)).toEqual(
            expect.arrayContaining(entries.slice(1)),
        );
    } finally {
        await watcher.reset();
        await hub.close();
        await rm(temporary, { recursive: true, force: true });
    }
});

it('bounds a hung alias probe and keeps healthy aliases updating without duplicate hung requests', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-link-timeout-'));
    const target = join(await realpath(temporary), 'target.txt');
    await writeFile(target, 'before');
    const root = join(temporary, 'project');
    const hungEntry = join(root, 'hung.txt');
    const healthyEntry = join(root, 'healthy.txt');
    const release = Promise.withResolvers<{ root: string; path: string; workspacePath: string }>();
    const resolver = vi.fn((_sessionId: string, entry?: string) =>
        entry === hungEntry
            ? release.promise
            : Promise.resolve({ root, path: target, workspacePath: entry }),
    );
    const hub = new WatchHub();
    const registrations = vi.spyOn(hub, 'registerPoller');
    const changed = vi.fn<ConstructorParameters<typeof ExternalLinkWatcher>[3]>();
    const watcher = new ExternalLinkWatcher(resolver, hub, 60_000, changed, () => {});
    try {
        await watcher.reset({ sessionId: 'session', workbenchProjectId: 'project' });
        await Promise.all(
            [hungEntry, healthyEntry].map((workspacePath) =>
                watcher.note('session', {
                    root,
                    path: target,
                    workspacePath,
                }),
            ),
        );
        await writeFile(target, 'first update');
        const [registration] = registrations.mock.calls[0];
        await expect(registration.pollOnce()).rejects.toThrow(
            'External link metadata probe timed out',
        );
        expect(changed).toHaveBeenCalledOnce();
        await writeFile(target, 'second update');
        await registration.pollOnce();
        expect(changed).toHaveBeenCalledTimes(2);
        expect(resolver.mock.calls.filter(([, entry]) => entry === hungEntry)).toHaveLength(1);
    } finally {
        release.resolve({ root, path: target, workspacePath: hungEntry });
        await watcher.reset();
        await hub.close();
        await rm(temporary, { recursive: true, force: true });
    }
});
