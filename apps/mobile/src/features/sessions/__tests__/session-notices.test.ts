import { describe, expect, it } from 'vitest';

import {
    connectionBannerModel,
    connectionNoticeMessage,
    isConnectionBannerShown,
    isSessionListErrorShown,
    selectHomeNotice,
} from '../session-notices';

describe('offline notices', () => {
    it('shows the connection banner whenever the connection is not fresh, except for a version mismatch', () => {
        expect(isConnectionBannerShown(true, 'connected')).toBe(false);
        expect(isConnectionBannerShown(false, 'stale')).toBe(true);
        expect(isConnectionBannerShown(false, 'unverified')).toBe(true);
        expect(isConnectionBannerShown(false, 'version-mismatch')).toBe(false);
    });

    it('folds the saved copy age into the stale message instead of a second notice', () => {
        expect(connectionNoticeMessage('stale', 'saved 5m ago')).toBe(
            'Reconnecting… Showing Sessions saved 5m ago. Replies are paused.',
        );
        expect(connectionNoticeMessage('stale', null)).toBe(
            'Reconnecting… Showing the last known state. Replies are paused.',
        );
    });

    it('names the computer rather than a Mac', () => {
        const message = connectionNoticeMessage('unverified', null);
        expect(message).toBe(
            'Pairing not verified. If this phone was revoked on your computer, choose Forget this computer in Settings, then pair again.',
        );
        expect(message).not.toMatch(/\bMac\b/u);
    });

    it('explains each Relay refusal instead of a generic reconnecting notice', () => {
        expect(connectionNoticeMessage('stale', null, undefined, 'host-offline')).toBe(
            'Caxri on your computer is offline. Open Caxri on your computer; this phone reconnects automatically.',
        );
        expect(connectionNoticeMessage('stale', null, undefined, 'unauthorized')).toContain(
            'Create pairing code',
        );
        expect(connectionNoticeMessage('stale', null, undefined, 'busy')).toBe(
            'The Relay is busy. Retrying automatically.',
        );
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

describe('selectHomeNotice', () => {
    const none = {
        connection: null,
        isListErrorShown: false,
        isListVisible: true,
        isSavedCopy: false,
        isTruncated: false,
        update: null,
    } as const;

    it('shows nothing when nothing needs attention', () => {
        expect(selectHomeNotice(none)).toBeNull();
    });

    it('shows only the most severe notice when several apply', () => {
        expect(
            selectHomeNotice({
                connection: 'stale',
                isListErrorShown: true,
                isListVisible: true,
                isSavedCopy: true,
                isTruncated: true,
                update: 'available',
            }),
        ).toBe('connection-stale');
        expect(selectHomeNotice({ ...none, connection: 'unverified', update: 'available' })).toBe(
            'connection-unverified',
        );
    });

    it('lets a version mismatch outrank the connection it caused', () => {
        expect(selectHomeNotice({ ...none, connection: 'stale', update: 'mismatch' })).toBe(
            'update-mismatch',
        );
        expect(selectHomeNotice({ ...none, connection: 'stale', update: 'checking' })).toBe(
            'update-required',
        );
    });

    it('ranks an optional update below a list failure and above the saved copy note', () => {
        expect(selectHomeNotice({ ...none, isListErrorShown: true, update: 'available' })).toBe(
            'list-error',
        );
        expect(selectHomeNotice({ ...none, isSavedCopy: true, update: 'available' })).toBe(
            'update-available',
        );
        expect(selectHomeNotice({ ...none, isSavedCopy: true, isTruncated: true })).toBe(
            'saved-copy',
        );
        expect(selectHomeNotice({ ...none, isTruncated: true })).toBe('truncated');
    });

    it('keeps the list-only notices off a Session detail', () => {
        expect(
            selectHomeNotice({
                ...none,
                isListErrorShown: true,
                isListVisible: false,
                isSavedCopy: true,
                isTruncated: true,
            }),
        ).toBeNull();
        expect(selectHomeNotice({ ...none, connection: 'stale', isListVisible: false })).toBe(
            'connection-stale',
        );
    });
});

describe('connection banner model', () => {
    it('offers an immediate reconnect on a stale connection and warns on actionable Relay failures', () => {
        expect(connectionBannerModel('stale')).toEqual({ action: 'reconnect', tone: 'muted' });
        expect(connectionBannerModel('stale', 'busy')).toEqual({
            action: 'reconnect',
            tone: 'muted',
        });
        expect(connectionBannerModel('stale', 'host-offline')).toEqual({
            action: 'reconnect',
            tone: 'warning',
        });
        expect(connectionBannerModel('stale', 'unauthorized')).toEqual({
            action: 'settings',
            tone: 'warning',
        });
        expect(connectionBannerModel('unverified', 'unauthorized')).toEqual({
            action: 'retry',
            tone: 'warning',
        });
    });
});
