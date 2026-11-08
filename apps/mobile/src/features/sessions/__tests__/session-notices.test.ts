import { describe, expect, it } from 'vitest';

import {
    CONNECTION_NOTICE_SETTLE_MS,
    connectionBannerModel,
    connectionIslandLabel,
    connectionNoticeMessage,
    createFirstShownTimes,
    createHomeNoticeSelections,
    drawnHomeNotice,
    HOME_NOTICE_SETTLE_MS,
    homeNoticeCandidates,
    homeNoticeSettleDelay,
    isConnectionBannerShown,
    isSessionListErrorShown,
    pinnedRouteOf,
    selectHomeNotice,
    transientNoticeRemainingMs,
    TRUNCATED_NOTICE_VISIBLE_MS,
    waitingHomeNotice,
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
        expect(connectionBannerModel('stale')).toEqual({
            action: 'reconnect',
            presentation: 'island',
            tone: 'muted',
        });
        expect(connectionBannerModel('stale', 'busy')).toEqual({
            action: 'reconnect',
            presentation: 'island',
            tone: 'muted',
        });
        expect(connectionBannerModel('stale', 'host-offline')).toEqual({
            action: 'reconnect',
            presentation: 'banner',
            tone: 'warning',
        });
        expect(connectionBannerModel('stale', 'unauthorized')).toEqual({
            action: 'settings',
            presentation: 'banner',
            tone: 'warning',
        });
        expect(connectionBannerModel('unverified', 'unauthorized')).toEqual({
            action: 'retry',
            presentation: 'banner',
            tone: 'warning',
        });
    });
});

describe('pinned connection method', () => {
    it('names the pinned method in the island label', () => {
        expect(connectionIslandLabel(null, undefined, null, 'direct')).toBe(
            'Direct only · Reconnecting…',
        );
        expect(connectionIslandLabel('5m ago', undefined, null, 'relay')).toBe(
            'Relay only · Reconnecting… · 5m ago',
        );
        expect(connectionIslandLabel(null, undefined, 'busy', 'direct')).toBe(
            'Relay busy, retrying…',
        );
    });

    it('points a persistent pinned reconnect at the connection method setting', () => {
        expect(connectionBannerModel('stale', null, 'direct', false).action).toBe('reconnect');
        expect(connectionBannerModel('stale', null, 'direct', true)).toEqual({
            action: 'settings',
            presentation: 'island',
            tone: 'muted',
        });
        expect(connectionBannerModel('stale', null, null, true).action).toBe('reconnect');
        expect(pinnedRouteOf('auto')).toBeNull();
        expect(pinnedRouteOf('relay')).toBe('relay');
    });
});

describe('connection island label', () => {
    it('names the state in a few words and keeps the saved copy age', () => {
        expect(connectionIslandLabel(null)).toBe('Reconnecting…');
        expect(connectionIslandLabel('saved 5m ago')).toBe('Reconnecting… · saved 5m ago');
        expect(connectionIslandLabel('saved 5m ago', undefined, 'busy')).toBe(
            'Relay busy, retrying…',
        );
    });
});

describe('waitingHomeNotice', () => {
    const none = {
        connection: null,
        isListErrorShown: false,
        isListVisible: true,
        isSavedCopy: false,
        isTruncated: false,
        update: null,
    } as const;

    it('keeps an update offer on screen while a reconnect notice waits to settle', () => {
        const candidates = homeNoticeCandidates({
            ...none,
            connection: 'stale',
            update: 'available',
        });
        expect(candidates).toEqual(['connection-stale', 'update-available']);
        expect(waitingHomeNotice(candidates)).toBe('update-available');
    });

    it('draws nothing while only self-clearing notices wait', () => {
        expect(
            waitingHomeNotice(
                homeNoticeCandidates({ ...none, connection: 'stale', isSavedCopy: true }),
            ),
        ).toBeNull();
    });
});

describe('homeNoticeSettleDelay', () => {
    it('holds back only the notices a quick startup clears on its own', () => {
        expect(homeNoticeSettleDelay('connection-stale')).toBe(CONNECTION_NOTICE_SETTLE_MS);
        expect(homeNoticeSettleDelay('saved-copy')).toBe(HOME_NOTICE_SETTLE_MS);
    });

    it('shows notices that need the user or report a lasting fact at once', () => {
        for (const kind of [
            'connection-unverified',
            'list-error',
            'truncated',
            'update-available',
            'update-mismatch',
            'update-required',
        ] as const) {
            expect(homeNoticeSettleDelay(kind)).toBe(0);
        }
        expect(homeNoticeSettleDelay(null)).toBe(0);
    });
});

describe('drawnHomeNotice', () => {
    it('keeps the Reconnecting notice off screen while it waits to settle', () => {
        expect(
            drawnHomeNotice({ candidates: ['connection-stale'], held: null, settled: null }),
        ).toBeNull();
        expect(
            drawnHomeNotice({
                candidates: ['connection-stale'],
                held: null,
                settled: 'connection-stale',
            }),
        ).toBe('connection-stale');
    });

    it('keeps a held notice on screen after the connection briefly recovers', () => {
        expect(drawnHomeNotice({ candidates: [], held: 'connection-stale', settled: null })).toBe(
            'connection-stale',
        );
        expect(
            drawnHomeNotice({
                candidates: ['saved-copy'],
                held: 'connection-stale',
                settled: null,
            }),
        ).toBe('connection-stale');
    });

    it('lets a notice that needs no wait replace a held one at once', () => {
        expect(
            drawnHomeNotice({
                candidates: ['update-required'],
                held: 'connection-stale',
                settled: null,
            }),
        ).toBe('update-required');
    });

    it('falls back to a waiting candidate once nothing is held', () => {
        expect(
            drawnHomeNotice({
                candidates: ['connection-stale', 'update-available'],
                held: null,
                settled: null,
            }),
        ).toBe('update-available');
    });
});

describe('createHomeNoticeSelections', () => {
    it('keeps the first selection time while any screen still selects the notice', () => {
        const selections = createHomeNoticeSelections();
        expect(selections.since('connection-stale')).toBeNull();
        expect(selections.acquire('connection-stale', 1_000)).toBe(1_000);
        expect(selections.acquire('connection-stale', 5_000)).toBe(1_000);
        selections.release('connection-stale');
        expect(selections.since('connection-stale')).toBe(1_000);
    });

    it('starts over once no screen selects the notice', () => {
        const selections = createHomeNoticeSelections();
        selections.acquire('saved-copy', 1_000);
        selections.release('saved-copy');
        expect(selections.since('saved-copy')).toBeNull();
        expect(selections.acquire('saved-copy', 9_000)).toBe(9_000);
    });
});

describe('transient truncated island', () => {
    it('keeps the first draw time per count, so the island does not return when the list comes back into view', () => {
        const firstShown = createFirstShownTimes();
        expect(firstShown('host:64/65', 1_000)).toBe(1_000);
        expect(firstShown('host:64/65', 9_000)).toBe(1_000);
        expect(firstShown('host:64/66', 9_000)).toBe(9_000);
    });

    it('gives a redrawn island only what is left of its time', () => {
        expect(transientNoticeRemainingMs(1_000, 1_000)).toBe(TRUNCATED_NOTICE_VISIBLE_MS);
        expect(transientNoticeRemainingMs(1_000, 2_500)).toBe(TRUNCATED_NOTICE_VISIBLE_MS - 1_500);
        expect(transientNoticeRemainingMs(1_000, 1_000 + TRUNCATED_NOTICE_VISIBLE_MS + 1)).toBe(0);
    });
});
