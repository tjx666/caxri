import { describe, expect, it } from 'vitest';

import {
    connectionBannerCopy,
    isConnectionBannerShown,
    isSessionListErrorShown,
} from '../session-notices';

describe('offline notices', () => {
    it('shows the connection banner whenever the connection is not fresh, except for a version mismatch', () => {
        expect(isConnectionBannerShown(true, 'connected')).toBe(false);
        expect(isConnectionBannerShown(false, 'stale')).toBe(true);
        expect(isConnectionBannerShown(false, 'unverified')).toBe(true);
        expect(isConnectionBannerShown(false, 'version-mismatch')).toBe(false);
    });

    it('does not repeat what a labeled saved copy already says', () => {
        expect(connectionBannerCopy('stale', true).body).toBe(
            'Replies are paused until Caxri reconnects.',
        );
        expect(connectionBannerCopy('stale', false).body).toBe(
            'Showing the last known state. Replies are paused.',
        );
        expect(connectionBannerCopy('stale', true).accessibilityLabel).toBe(
            'Connection interrupted. Replies are paused until Caxri reconnects.',
        );
    });

    it('names the computer rather than a Mac', () => {
        const copy = connectionBannerCopy('unverified', true);
        expect(copy.title).toBe('Pairing could not be verified');
        expect(copy.body).toBe(
            'If this device was revoked on your computer, forget it and pair again.',
        );
        expect(copy.accessibilityLabel).not.toMatch(/\bMac\b/u);
    });

    it('leaves a list load failure to the connection banner while it is up', () => {
        const failed = { error: 'Unable to load Sessions.', hasLoaded: true };
        expect(isSessionListErrorShown({ ...failed, isConnectionNoticeShown: false })).toBe(true);
        expect(isSessionListErrorShown({ ...failed, isConnectionNoticeShown: true })).toBe(false);
        expect(
            isSessionListErrorShown({
                ...failed,
                hasLoaded: false,
                isConnectionNoticeShown: false,
            }),
        ).toBe(false);
        expect(
            isSessionListErrorShown({
                error: null,
                hasLoaded: true,
                isConnectionNoticeShown: false,
            }),
        ).toBe(false);
    });
});
