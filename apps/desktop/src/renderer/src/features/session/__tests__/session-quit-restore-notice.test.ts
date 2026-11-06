import { describe, expect, it } from 'vitest';

import {
    isQuitRestoreNoticeFresh,
    QUIT_RESTORE_NOTICE_MAX_AGE_MS,
    quitRestoreAllSkippedKey,
    quitRestoreNoticeKey,
} from '../session-quit-restore-notice';

describe('quitRestoreNoticeKey', () => {
    it('offers nothing when the last quit stopped nothing', () => {
        expect(quitRestoreNoticeKey(0)).toBeUndefined();
    });

    it('uses the singular for one Session and the plural above', () => {
        expect(quitRestoreNoticeKey(1)).toBe('session.quitRestore.noticeOne');
        expect(quitRestoreNoticeKey(2)).toBe('session.quitRestore.noticeOther');
    });
});

describe('quitRestoreAllSkippedKey', () => {
    it('names the failure only when nothing was restored and something was skipped', () => {
        expect(quitRestoreAllSkippedKey({ restored: 0, skipped: 1 })).toBe(
            'session.quitRestore.allSkippedOne',
        );
        expect(quitRestoreAllSkippedKey({ restored: 0, skipped: 2 })).toBe(
            'session.quitRestore.allSkippedOther',
        );
        expect(quitRestoreAllSkippedKey({ restored: 1, skipped: 2 })).toBeUndefined();
        expect(quitRestoreAllSkippedKey({ restored: 0, skipped: 0 })).toBeUndefined();
    });
});

describe('isQuitRestoreNoticeFresh', () => {
    const now = 1_000_000_000_000;

    it('offers a recent quit and drops one past the limit', () => {
        expect(isQuitRestoreNoticeFresh(now - 60_000, now)).toBe(true);
        expect(isQuitRestoreNoticeFresh(now - QUIT_RESTORE_NOTICE_MAX_AGE_MS, now)).toBe(true);
        expect(isQuitRestoreNoticeFresh(now - QUIT_RESTORE_NOTICE_MAX_AGE_MS - 1, now)).toBe(false);
    });

    it('offers nothing without a recorded time', () => {
        expect(isQuitRestoreNoticeFresh(undefined, now)).toBe(false);
    });
});
