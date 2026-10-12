import type { FileWatchFailureReason, FileWatchLimit, FileWatchLimitAlert } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';

import { INOTIFY_START_FAILURE } from './inotify-probe';

/**
 * Matches the macOS FSEvents "must rescan" advisory. `@parcel/watcher@2.6.0`'s `FSEventsBackend.cc` attaches one of
 * three messages to a batch when `kFSEventStreamEventFlagMustScanSubDirs` is set ("Events were dropped by the FSEvents
 * client.", "Events were dropped by the kernel.", or "Too many events.") always followed by "File system must be
 * re-scanned." (see `src/macos/FSEventsBackend.cc:82-88`). The stream itself keeps running and its callback stays
 * registered (contrast `Watcher::notifyError` in `src/Watcher.cc:113-120`, which really does tear the subscription
 * down), so this is advisory, not a dead subscription: the caller should reconcile once and keep watching natively
 * instead of degrading to polling.
 */
export function isMustRescanAdvisory(error: unknown): boolean {
    const message = errorMessage(error, '');
    return /must be re-scanned/i.test(message) || /events were dropped/i.test(message);
}

/**
 * Classifies a native watch failure. `@parcel/watcher@2.6.0`'s `InotifyBackend.cc` reports an exhausted
 * `max_user_watches` only as message text, `inotify_add_watch on '<dir>' failed: No space left on device` (ENOSPC). An
 * exhausted `max_user_instances` would hang the backend instead of failing, so that reason comes from
 * {@link INOTIFY_START_FAILURE}, which the start probe raises in its place.
 */
export function watchFailureReason(error: unknown): FileWatchFailureReason {
    const message = errorMessage(error, '');
    if (message.startsWith('inotify_add_watch') && message.endsWith('No space left on device'))
        return 'watch-limit';
    if (message === INOTIFY_START_FAILURE) return 'instance-limit';
    return 'other';
}

/**
 * Log fields for a native watch failure: the free-form message for the one incident, the closed reason to count them.
 */
export function watchFailureFields(error: unknown): {
    error: string;
    reason: FileWatchFailureReason;
} {
    return { error: errorMessage(error, 'unknown'), reason: watchFailureReason(error) };
}

/**
 * Tracks which watch registrations are polling because of a kernel limit, so the Server can tell clients why the file
 * tree and Git status now lag. Every limit-caused degradation raises again (a window that connected after the first one
 * still learns about it; clients fold repeats into one notice), and the alert clears once no registration is degraded
 * for that cause.
 */
export class WatchLimitAlerts<Registration> {
    private readonly limited = new Map<Registration, FileWatchLimit>();

    constructor(private readonly emit: (alert: FileWatchLimitAlert) => void) {}

    degraded(registration: Registration, error: unknown): void {
        const reason = watchFailureReason(error);
        if (reason === 'other') return;
        this.limited.set(registration, reason);
        this.emit({ state: 'raised', reason });
    }

    recovered(registration: Registration): void {
        if (this.limited.delete(registration) && this.limited.size === 0)
            this.emit({ state: 'cleared' });
    }
}
