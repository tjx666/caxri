import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../../watch';
import { AgentTranscriptWatcher } from '../transcript-watcher';

/**
 * Holds the transcript `stat` calls while armed, so a test can open the window between the first discovery install's
 * initial signature read and its post-subscribe check, the window a loaded CI runner opened by chance.
 */
const statGate = vi.hoisted(() => ({
    path: undefined as string | undefined,
    calls: 0,
    holdCall: 0,
    released: undefined as PromiseWithResolvers<void> | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        stat: async (...arguments_: Parameters<typeof actual.stat>) => {
            if (statGate.path !== undefined && String(arguments_[0]) === statGate.path) {
                statGate.calls += 1;
                if (statGate.calls === statGate.holdCall) await statGate.released?.promise;
            }
            return actual.stat(...arguments_);
        },
    };
});

const directories: string[] = [];

afterEach(async () => {
    statGate.path = undefined;
    statGate.calls = 0;
    const cleanup = [...directories];
    directories.length = 0;
    await Promise.all(cleanup.map((directory) => rm(directory, { recursive: true })));
});

async function emptyTranscript(): Promise<string> {
    const baseRoot = await mkdtemp(join(tmpdir(), 'caxri-transcript-late-bind-'));
    directories.push(baseRoot);
    const root = join(baseRoot, 'project');
    await mkdir(root);
    const path = join(root, 'session.jsonl');
    await writeFile(path, '');
    // The watcher stats the resolved path (`/private/var` on macOS).
    return realpath(path);
}

/**
 * A mobile subscriber that read `missing`, then a transcript that appears empty while the second `stat` of the first
 * install (its post-subscribe check) is held until the next discovery tick has ended discovery.
 */
async function heldLateBind() {
    const path = await emptyTranscript();
    const subscribe = vi.fn(() =>
        Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    ) as unknown as typeof parcelWatcher.subscribe;
    const watchHub = new WatchHub({ subscribe });
    const emit = vi.fn();
    let isAvailable = false;
    const locateForTerminal = vi.fn(() =>
        Promise.resolve(
            isAvailable
                ? { baseRoot: dirname(dirname(path)), path, root: dirname(path) }
                : undefined,
        ),
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

    const released = Promise.withResolvers<void>();
    Object.assign(statGate, { path, calls: 0, holdCall: 2, released });
    isAvailable = true;
    await vi.waitFor(() => expect(statGate.calls).toBe(2));
    // A later discovery tick finds the entry already installed and ends discovery while the first install is held.
    const discovery = (watcher as unknown as { mobileDiscovery: Map<string, unknown> })
        .mobileDiscovery;
    await vi.waitFor(() => expect(discovery.has('terminal-a')).toBe(false));
    return {
        emit,
        release: () => released.resolve(),
        watcher,
        close: async () => {
            await watcher.close();
            await watchHub.close();
        },
    };
}

describe('AgentTranscriptWatcher late-bound empty transcript', () => {
    it('notifies the mobile subscriber once even when a later discovery tick ends discovery first', async () => {
        const { close, emit, release, watcher } = await heldLateBind();
        release();
        await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
        expect(emit).toHaveBeenCalledWith({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });
        watcher.unwatchMobile('terminal-a');
        await close();
    });

    it('does not notify a subscriber that left while the install was held', async () => {
        const { close, emit, release, watcher } = await heldLateBind();
        watcher.unwatchMobile('terminal-a');
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(emit).not.toHaveBeenCalled();
        await close();
    });
});
