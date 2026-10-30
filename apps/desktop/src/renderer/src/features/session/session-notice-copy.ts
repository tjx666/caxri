import { translate } from '../../i18n';
import { sessionTitleForDisplay } from './session-title';

/**
 * Longest Session title a lifecycle notice quotes. Titles are user- and Agent-authored and effectively unbounded, so a
 * runaway one would push the notice's own verb and its action button out of the toast's fixed width.
 */
const SESSION_NOTICE_TITLE_MAX_LENGTH = 48;

/**
 * The Session as a notice names it: its quoted title, or the bare noun when it has none. An empty `title` is
 * representable in the Session record (a Shell-only Session has no Agent to name it) and quoting nothing reads as a
 * rendering bug.
 */
function quotedSessionName(rawTitle: string | undefined): string | undefined {
    const title = sessionTitleForDisplay(rawTitle?.trim() ?? '', translate);
    if (title.length === 0) return undefined;
    // Count and cut by code point: an Agent-authored title can end on an emoji, and a UTF-16 cut would leave a lone
    // surrogate that renders as the replacement character.
    const characters = [...title];
    return characters.length <= SESSION_NOTICE_TITLE_MAX_LENGTH
        ? title
        : `${characters.slice(0, SESSION_NOTICE_TITLE_MAX_LENGTH).join('').trimEnd()}…`;
}

/**
 * Copy for the toast that tells the user Server Core archived a Session because its pull request settled. Unlike a
 * manual archive the user did nothing, so the notice must say why the row vanished.
 */
export function describeAutoArchivedSession(
    rawTitle: string | undefined,
    pullRequestState: 'closed' | 'merged',
): string {
    const title = quotedSessionName(rawTitle);
    const session =
        title === undefined
            ? translate('session.notice.autoArchivedSession')
            : translate('session.notice.quotedName', { title });
    return translate(
        pullRequestState === 'merged'
            ? 'session.notice.autoArchivedMerged'
            : 'session.notice.autoArchivedClosed',
        { session },
    );
}

/**
 * A restore happens inside a dialog large enough to cover the PrimarySidebar row it just brought back, so unlike an
 * archive it says so.
 */
export function describeRestoredSession(rawTitle: string | undefined): string {
    const title = quotedSessionName(rawTitle);
    if (title === undefined) return translate('session.notice.restoredUntitled');
    return translate('session.notice.restored', { title });
}

/**
 * Copy for a batch restore. Quoting a batch is not possible in a toast's width, so the count carries the record; a
 * single-Session batch still names its Session, because there the title is the useful part.
 */
export function describeRestoredSessions(titles: ReadonlyArray<string | undefined>): string {
    if (titles.length === 1) return describeRestoredSession(titles[0]);
    return translate('session.notice.restoredCount', { count: titles.length });
}
