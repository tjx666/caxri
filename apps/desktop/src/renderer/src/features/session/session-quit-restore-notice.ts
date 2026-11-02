/**
 * The launch notice's words for `count` Sessions the last quit stopped, or `undefined` when there is nothing to offer.
 */
export function quitRestoreNoticeKey(
    count: number,
): 'session.quitRestore.noticeOne' | 'session.quitRestore.noticeOther' | undefined {
    if (count <= 0) return undefined;
    return count === 1 ? 'session.quitRestore.noticeOne' : 'session.quitRestore.noticeOther';
}

/**
 * The result toast's key when nothing came back: a headline of "Restored 0 Sessions" followed by what was skipped reads
 * as a success that failed, so an all-skipped run names the failure instead. `undefined` means the usual headline.
 */
export function quitRestoreAllSkippedKey(result: {
    restored: number;
    skipped: number;
}): 'session.quitRestore.allSkippedOne' | 'session.quitRestore.allSkippedOther' | undefined {
    if (result.restored !== 0 || result.skipped <= 0) return undefined;
    return result.skipped === 1
        ? 'session.quitRestore.allSkippedOne'
        : 'session.quitRestore.allSkippedOther';
}
