import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../../watch-hub';
import { AgentTranscriptWatcher } from '../transcript-watcher';

type SubscribeCallback = Parameters<typeof parcelWatcher.subscribe>[1];

const directories: string[] = [];

async function transcriptFixture(): Promise<string> {
    const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-transcript-watcher-'));
    directories.push(baseRoot);
    const root = join(baseRoot, 'project');
    await mkdir(root);
    const path = join(root, 'session.jsonl');
    await writeFile(path, '{"message":"initial"}\n');
    return path;
}

function nativeSubscribe() {
    const callbacks: SubscribeCallback[] = [];
    const unsubscribe = vi.fn(() => Promise.resolve());
    const subscribe = vi.fn((_root: string, callback: SubscribeCallback) => {
        callbacks.push(callback);
        return Promise.resolve({ unsubscribe });
    }) as unknown as typeof parcelWatcher.subscribe;
    return { callbacks, subscribe, unsubscribe };
}

function transcriptLocation(path: string, root = dirname(path), baseRoot = dirname(root)) {
    return { baseRoot, path, root };
}

function retainedGenerationCount(watcher: AgentTranscriptWatcher): number {
    return (
        watcher as unknown as {
            generations: Map<string, number>;
        }
    ).generations.size;
}

afterEach(async () => {
    const cleanupDirectories = [...directories];
    directories.length = 0;
    await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true })));
});

describe('AgentTranscriptWatcher', () => {
    it('discovers a Codex-style transcript only while mobile has a conversation subscription', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe, unsubscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        let isAvailable = false;
        const locateForTerminal = vi.fn(() =>
            Promise.resolve(isAvailable ? transcriptLocation(path) : undefined),
        );
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => {},
            locateForTerminal,
            mobileDiscoveryIntervalMs: 10,
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watchMobile('terminal-a');
        expect(subscribe).not.toHaveBeenCalled();
        isAvailable = true;
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        watcher.unwatchMobile('terminal-a');
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        callbacks[0]?.(null, [{ path, type: 'update' }]);
        expect(emit).toHaveBeenCalledOnce();
        expect(locateForTerminal).toHaveBeenCalled();
        await watcher.close();
        await watchHub.close();
    });

    it('notifies a mobile subscriber when a late-bound transcript is empty', async () => {
        const path = await transcriptFixture();
        await writeFile(path, '');
        const { subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        let isAvailable = false;
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => {},
            locateForTerminal: () =>
                Promise.resolve(isAvailable ? transcriptLocation(path) : undefined),
            mobileDiscoveryIntervalMs: 10,
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watchMobile('terminal-a');
        expect(subscribe).not.toHaveBeenCalled();
        isAvailable = true;
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
            expect(emit).toHaveBeenCalledWith({
                event: 'agentTranscript.changed',
                payload: { terminalId: 'terminal-a' },
            }),
        );
        expect(emit).toHaveBeenCalledOnce();
        watcher.unwatchMobile('terminal-a');
        await watcher.close();
        await watchHub.close();
    });

    it('keeps a Desktop transcript watch when the last mobile subscriber leaves', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe, unsubscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });
        await watcher.watch('terminal-a');
        await watcher.watchMobile('terminal-a');
        await watcher.watchMobile('terminal-a');
        watcher.unwatchMobile('terminal-a');
        // A second phone still has the Conversation open, which keeps idle suspension away from the Agent.
        expect(watcher.isObservedRemotely('terminal-a')).toBe(true);
        watcher.unwatchMobile('terminal-a');
        expect(watcher.isObservedRemotely('terminal-a')).toBe(false);
        callbacks[0]?.(null, [{ path, type: 'update' }]);
        expect(emit).toHaveBeenCalledOnce();
        expect(unsubscribe).not.toHaveBeenCalled();
        await watcher.close();
        await watchHub.close();
    });

    it('emits a content-free targeted event for the opened transcript', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        callbacks[0]?.(null, [{ path, type: 'update' }]);

        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        await watcher.close();
        await watchHub.close();
    });

    it('matches a native event that uses the canonical spelling of a symlinked provider path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-transcript-watcher-alias-'));
        directories.push(directory);
        const canonicalConfig = join(directory, 'canonical-config');
        const canonicalRoot = join(canonicalConfig, 'projects', 'project');
        const aliasConfig = join(directory, 'alias-config');
        await mkdir(canonicalRoot, { recursive: true });
        await symlink(canonicalConfig, aliasConfig, 'dir');
        const sourcePath = join(aliasConfig, 'projects', 'project', 'session.jsonl');
        await writeFile(sourcePath, '{"message":"initial"}\n');
        const canonicalPath = await realpath(sourcePath);
        const { callbacks, subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () =>
                transcriptLocation(
                    sourcePath,
                    join(aliasConfig, 'projects', 'project'),
                    join(aliasConfig, 'projects'),
                ),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        callbacks[0]?.(null, [{ path: canonicalPath, type: 'update' }]);

        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        await watcher.close();
        await watchHub.close();
    });

    it('detects a transcript update that lands while the native subscription installs', async () => {
        const path = await transcriptFixture();
        const subscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const subscribe = vi.fn(
            () => subscription.promise,
        ) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        const installing = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        await appendFile(path, '{"message":"during-subscribe"}\n');
        subscription.resolve({ unsubscribe: () => Promise.resolve() });
        await installing;

        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        await watcher.close();
        await watchHub.close();
    });

    it('replaces the old subscription when the Terminal binds to a new transcript path', async () => {
        const firstPath = await transcriptFixture();
        const secondPath = await transcriptFixture();
        const { callbacks, subscribe, unsubscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        let boundPath = firstPath;
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(boundPath),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        boundPath = secondPath;
        await watcher.watch('terminal-a');
        callbacks[0]?.(null, [{ path: firstPath, type: 'update' }]);
        callbacks[1]?.(null, [{ path: secondPath, type: 'update' }]);

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        await watcher.close();
        await watchHub.close();
    });

    it('rebinds to the latest transcript when its path changes during a pending install', async () => {
        const firstPath = await transcriptFixture();
        const secondPath = await transcriptFixture();
        const firstSubscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const callbacks: SubscribeCallback[] = [];
        let subscriptionCount = 0;
        const subscribe = vi.fn((_root: string, callback: SubscribeCallback) => {
            callbacks.push(callback);
            subscriptionCount += 1;
            return subscriptionCount === 1
                ? firstSubscription.promise
                : Promise.resolve({ unsubscribe: () => Promise.resolve() });
        }) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        let boundPath = firstPath;
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(boundPath),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        const firstWatch = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        boundPath = secondPath;
        const rebound = watcher.watch('terminal-a');
        firstSubscription.resolve({ unsubscribe: () => Promise.resolve() });
        await Promise.all([firstWatch, rebound]);
        callbacks[0]?.(null, [{ path: firstPath, type: 'update' }]);
        callbacks[1]?.(null, [{ path: secondPath, type: 'update' }]);

        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        await watcher.close();
        await watchHub.close();
    });

    it('refuses to subscribe to a transcript symlink outside the provider root', async () => {
        const outsidePath = await transcriptFixture();
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-transcript-provider-root-'));
        directories.push(baseRoot);
        const root = join(baseRoot, 'project');
        await mkdir(root);
        const path = join(root, 'session.jsonl');
        await symlink(outsidePath, path, 'file');
        const { subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const watcher = new AgentTranscriptWatcher({
            emit: vi.fn(),
            locationForTerminal: () => transcriptLocation(path, root, baseRoot),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');

        expect(subscribe).not.toHaveBeenCalled();
        await watcher.close();
        await watchHub.close();
    });

    it('releases an old subscription and polls until a missing provider root appears', async () => {
        const firstPath = await transcriptFixture();
        const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-transcript-missing-root-'));
        directories.push(baseRoot);
        const root = join(baseRoot, 'project');
        const path = join(root, 'session.jsonl');
        const unsubscribe = vi.fn(() => Promise.resolve());
        let subscriptionCount = 0;
        const subscribe = vi.fn(() => {
            subscriptionCount += 1;
            return subscriptionCount === 1
                ? Promise.resolve({ unsubscribe })
                : Promise.reject(new Error('root missing'));
        }) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        let location = transcriptLocation(firstPath);
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => location,
            pollIntervalMs: 10,
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        location = transcriptLocation(path, root, baseRoot);
        await watcher.watch('terminal-a');
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(watchHub.snapshot()).toMatchObject({ polling: 1, registrations: 1 });

        await mkdir(root);
        await writeFile(path, '{"message":"created"}\n');
        await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

        await watcher.close();
        await watchHub.close();
    });

    it('disposes and suppresses events after the terminal is forgotten', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe, unsubscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        watcher.forgetSession('session-a');
        callbacks[0]?.(null, [{ path, type: 'update' }]);
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());

        expect(emit).not.toHaveBeenCalled();
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watcher.close();
        await watchHub.close();
    });

    it('retains a forgotten generation only until a pending install settles', async () => {
        const path = await transcriptFixture();
        const subscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const unsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi.fn(
            () => subscription.promise,
        ) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });
        const installing = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

        watcher.forgetTerminal('terminal-a');
        expect(retainedGenerationCount(watcher)).toBe(1);
        subscription.resolve({ unsubscribe });
        await installing;

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(emit).not.toHaveBeenCalled();
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watcher.close();
        await watchHub.close();
    });

    it('does not revive a waiter that started before its pending install was forgotten', async () => {
        const path = await transcriptFixture();
        const subscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const unsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi.fn(
            () => subscription.promise,
        ) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });
        const installing = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        const duplicateWaiter = watcher.watch('terminal-a');

        watcher.forgetTerminal('terminal-a');
        subscription.resolve({ unsubscribe });
        await Promise.all([installing, duplicateWaiter]);

        expect(subscribe).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(emit).not.toHaveBeenCalled();
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watcher.close();
        await watchHub.close();
    });

    it('keeps a reused Terminal ID isolated from its forgotten pending install', async () => {
        const path = await transcriptFixture();
        const firstSubscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const callbacks: SubscribeCallback[] = [];
        const unsubscribe = vi.fn(() => Promise.resolve());
        let subscriptionCount = 0;
        const subscribe = vi.fn((_root: string, callback: SubscribeCallback) => {
            callbacks.push(callback);
            subscriptionCount += 1;
            return subscriptionCount === 1
                ? firstSubscription.promise
                : Promise.resolve({ unsubscribe });
        }) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });
        const forgottenInstall = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
        watcher.forgetTerminal('terminal-a');
        const reusedInstall = watcher.watch('terminal-a');

        firstSubscription.resolve({ unsubscribe });
        await Promise.all([forgottenInstall, reusedInstall]);
        callbacks[0]?.(null, [{ path, type: 'update' }]);
        callbacks[1]?.(null, [{ path, type: 'update' }]);

        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledOnce();
        expect(retainedGenerationCount(watcher)).toBe(1);
        watcher.forgetTerminal('terminal-a');
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2));
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watcher.close();
        await watchHub.close();
    });

    it('does not retain generations across Terminal watch and forget churn', async () => {
        const path = await transcriptFixture();
        const { subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const watcher = new AgentTranscriptWatcher({
            emit: vi.fn(),
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => [],
            watchHub,
        });

        await Promise.all(
            Array.from({ length: 256 }, async (_, index) => {
                const terminalId = `terminal-${index}`;
                await watcher.watch(terminalId);
                watcher.forgetTerminal(terminalId);
            }),
        );

        expect(retainedGenerationCount(watcher)).toBe(0);
        await watcher.close();
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watchHub.close();
    });

    it('clears generation state after a pending install settles during close', async () => {
        const path = await transcriptFixture();
        const subscription = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const unsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi.fn(
            () => subscription.promise,
        ) as unknown as typeof parcelWatcher.subscribe;
        const watchHub = new WatchHub({ subscribe });
        const watcher = new AgentTranscriptWatcher({
            emit: vi.fn(),
            locationForTerminal: () => transcriptLocation(path),
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });
        const installing = watcher.watch('terminal-a');
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

        const closing = watcher.close();
        expect(watcher.close()).toBe(closing);
        subscription.resolve({ unsubscribe });
        await Promise.all([installing, closing]);

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(retainedGenerationCount(watcher)).toBe(0);
        await watchHub.close();
    });
});
