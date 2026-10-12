import { spawn } from 'node:child_process';
import process from 'node:process';

import type parcelWatcher from '@parcel/watcher';

/**
 * The message `@parcel/watcher` itself would report for a failed `inotify_init1`, so the failure classifies as
 * `instance-limit` exactly like one the backend raised.
 */
export const INOTIFY_START_FAILURE = 'Unable to initialize inotify: Too many open files';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_SCRIPT = "require('node:fs').watch(require('node:os').tmpdir()).close()";

const shared: { probe?: Promise<boolean> } = {};

function runProbe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const child = spawn(process.execPath, ['-e', PROBE_SCRIPT], {
            stdio: 'ignore',
            timeout: PROBE_TIMEOUT_MS,
        });
        child.once('error', () => resolve(true));
        child.once('exit', (code, signal) => resolve(code === 0 || signal !== null));
    });
}

/**
 * Whether this account can create one more inotify instance right now, answered by a throwaway child process: libuv's
 * `fs.watch` reports a failed `inotify_init1` as an ordinary EMFILE error, and only a separate process leaves no
 * instance behind (libuv keeps its loop's inotify descriptor for the life of the loop). Anything other than that child
 * failing (a spawn error, a timeout) answers `true`, so the probe can only ever skip native watching for the one cause
 * it actually observed. Concurrent callers share one probe.
 */
export async function canStartInotifyInstance(): Promise<boolean> {
    shared.probe ??= runProbe();
    try {
        return await shared.probe;
    } finally {
        shared.probe = undefined;
    }
}

/**
 * Guards `@parcel/watcher`'s first Linux subscription in a process. Version 2.6.0 starts its shared inotify backend on
 * a thread and blocks the caller until that thread signals it started (`Backend::run` waits on `mStartedSignal`), but a
 * failed `inotify_init1` throws before the signal and `Backend::handleError` never sends it, so once the account has
 * used up `fs.inotify.max_user_instances` the subscribe call hangs the JS thread, and with it the whole Server. A new
 * backend starts only while the process holds no native subscription, so the probe runs only then; a failed probe
 * rejects the subscription like the backend would have, which degrades it to polling and raises the limit alert.
 */
export function withInotifyStartProbe(
    subscribe: typeof parcelWatcher.subscribe,
    hasLiveSubscription: () => boolean,
    canStartInotify: () => Promise<boolean> = canStartInotifyInstance,
): typeof parcelWatcher.subscribe {
    if (process.platform !== 'linux') return subscribe;
    return async (root, callback, options) => {
        if (!hasLiveSubscription() && !(await canStartInotify()))
            throw new Error(INOTIFY_START_FAILURE);
        return subscribe(root, callback, options);
    };
}
