import { describe, expect, it } from 'vitest';

import { quitRestoreNoticeKey } from '../session-quit-restore-notice';

describe('quitRestoreNoticeKey', () => {
    it('offers nothing when the last quit stopped nothing', () => {
        expect(quitRestoreNoticeKey(0)).toBeUndefined();
    });

    it('uses the singular for one Session and the plural above', () => {
        expect(quitRestoreNoticeKey(1)).toBe('session.quitRestore.noticeOne');
        expect(quitRestoreNoticeKey(2)).toBe('session.quitRestore.noticeOther');
    });
});
