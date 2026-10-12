import { describe, expect, it } from 'vitest';

import { watchFailureReason } from '../watch-failures';

describe('watchFailureReason', () => {
    it('names the inotify limit a native watch hit', () => {
        expect(
            watchFailureReason(
                new Error("inotify_add_watch on '/srv/app/src' failed: No space left on device"),
            ),
        ).toBe('watch-limit');
        expect(
            watchFailureReason(new Error('Unable to initialize inotify: Too many open files')),
        ).toBe('instance-limit');
    });

    it('leaves every other failure unclassified', () => {
        expect(
            watchFailureReason(
                new Error("inotify_add_watch on '/srv/app/src' failed: Permission denied"),
            ),
        ).toBe('other');
        expect(watchFailureReason(new Error('No space left on device'))).toBe('other');
        expect(watchFailureReason(undefined)).toBe('other');
    });
});
