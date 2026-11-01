/**
 * The launch notice's words for `count` Sessions the last quit stopped, or `undefined` when there is nothing to offer.
 */
export function quitRestoreNoticeKey(
    count: number,
): 'session.quitRestore.noticeOne' | 'session.quitRestore.noticeOther' | undefined {
    if (count <= 0) return undefined;
    return count === 1 ? 'session.quitRestore.noticeOne' : 'session.quitRestore.noticeOther';
}
