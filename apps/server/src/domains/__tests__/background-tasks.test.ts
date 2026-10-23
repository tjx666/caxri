import { describe, expect, it, vi } from 'vitest';

import { createBackgroundTasks, refreshWatchSessionInBackground } from '../background-tasks';

type Parameters_ = Parameters<typeof createBackgroundTasks>;

function setup(isInstalled: boolean) {
    const watchSession = vi.fn(() => Promise.resolve(isInstalled));
    const files = {
        watchSession,
        refreshWatchSession: vi.fn(() => Promise.resolve(isInstalled)),
    } as unknown as Parameters_[1];
    const observeWatcherAttached = vi.fn(() => Promise.resolve());
    const git = { observeWatcherAttached } as unknown as Parameters_[2];
    const logger = { write: vi.fn() } as unknown as Parameters_[0];
    const tasks = createBackgroundTasks(logger, files, git, () => Promise.resolve());
    return { files, git, logger, observeWatcherAttached, tasks, watchSession };
}

describe('background watch tasks', () => {
    it('refreshes Git status after the watcher is (re)installed', async () => {
        const { observeWatcherAttached, tasks } = setup(true);
        tasks.watchSessionInBackground('session-1');
        await vi.waitFor(() => expect(observeWatcherAttached).toHaveBeenCalledWith('session-1'));
    });

    it('skips the Git status refresh when the switch kept the same watcher attached', async () => {
        const { observeWatcherAttached, tasks, watchSession } = setup(false);
        tasks.watchSessionInBackground('session-2');
        await vi.waitFor(() => expect(watchSession).toHaveBeenCalledWith('session-2'));
        await Promise.resolve();
        expect(observeWatcherAttached).not.toHaveBeenCalled();
    });

    it('refreshes Git status after a forced Workbench Root rebind', async () => {
        const { files, git, logger, observeWatcherAttached } = setup(true);
        refreshWatchSessionInBackground(files, git, logger, 'session-3');
        await vi.waitFor(() => expect(observeWatcherAttached).toHaveBeenCalledWith('session-3'));
    });
});
