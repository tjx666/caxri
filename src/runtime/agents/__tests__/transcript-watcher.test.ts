import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../../watch-hub';
import { AgentTranscriptWatcher } from '../transcript-watcher';

type SubscribeCallback = Parameters<typeof parcelWatcher.subscribe>[1];

const directories: string[] = [];

async function transcriptFixture(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-transcript-watcher-'));
    directories.push(directory);
    const path = join(directory, 'session.jsonl');
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

afterEach(async () => {
    const cleanupDirectories = [...directories];
    directories.length = 0;
    await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true })));
});

describe('AgentTranscriptWatcher', () => {
    it('emits a content-free targeted event for the opened transcript', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            pathForTerminal: () => path,
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
        const canonicalDirectory = join(directory, 'canonical');
        const aliasDirectory = join(directory, 'alias');
        await mkdir(canonicalDirectory);
        await symlink(canonicalDirectory, aliasDirectory, 'dir');
        const sourcePath = join(aliasDirectory, 'session.jsonl');
        await writeFile(sourcePath, '{"message":"initial"}\n');
        const canonicalPath = await realpath(sourcePath);
        const { callbacks, subscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            pathForTerminal: () => sourcePath,
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
            pathForTerminal: () => path,
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
            pathForTerminal: () => boundPath,
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

    it('disposes and suppresses events after the terminal is forgotten', async () => {
        const path = await transcriptFixture();
        const { callbacks, subscribe, unsubscribe } = nativeSubscribe();
        const watchHub = new WatchHub({ subscribe });
        const emit = vi.fn();
        const watcher = new AgentTranscriptWatcher({
            emit,
            pathForTerminal: () => path,
            terminalIdsForSession: () => ['terminal-a'],
            watchHub,
        });

        await watcher.watch('terminal-a');
        watcher.forgetSession('session-a');
        callbacks[0]?.(null, [{ path, type: 'update' }]);
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());

        expect(emit).not.toHaveBeenCalled();
        await watcher.close();
        await watchHub.close();
    });
});
