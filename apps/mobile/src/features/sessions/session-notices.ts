import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';

/**
 * Whether the app-wide connection banner explains the screen. A version mismatch has its own update banner instead.
 */
export const isConnectionBannerShown = (
    isFresh: boolean,
    status: MobileConnectionStatus,
): boolean => !isFresh && status !== 'version-mismatch';

/**
 * The connection notice's one sentence pair. When the Session list is the copy saved on this phone and its screen is
 * showing, the stale message names that copy's age (`Showing Sessions saved 5m ago.`) instead of a second notice saying
 * the same thing.
 */
export const connectionNoticeMessage = (
    status: 'stale' | 'unverified',
    savedLabel: string | null,
    t: Translate = translate,
): string => {
    if (status === 'unverified') return t('sessions.banner.unverified');
    return savedLabel === null
        ? t('sessions.banner.stale')
        : t('sessions.banner.staleSaved', { saved: savedLabel });
};

/**
 * Whether the Session list shows its own `Unable to load Sessions` notice with Retry. While the connection banner is up
 * it already explains the outage, and a list Retry cannot reach the computer anyway.
 */
export const isSessionListErrorShown = ({
    error,
    hasLoaded,
    isConnectionNoticeShown,
}: {
    error: string | null;
    hasLoaded: boolean;
    isConnectionNoticeShown: boolean;
}): boolean => hasLoaded && error !== null && !isConnectionNoticeShown;

/**
 * Everything that can ask for the top of the Session home, most severe first. A screen shows exactly one: stacking
 * differently styled bars pushed the list down and made the user read each to learn which one mattered.
 */
export type HomeNoticeKind =
    | 'connection-stale'
    | 'connection-unverified'
    | 'list-error'
    | 'saved-copy'
    | 'truncated'
    | 'update-available'
    | 'update-mismatch'
    | 'update-required';

const HOME_NOTICE_PRIORITY: readonly HomeNoticeKind[] = [
    'update-mismatch',
    'update-required',
    'connection-unverified',
    'connection-stale',
    'list-error',
    'update-available',
    'saved-copy',
    'truncated',
];

/**
 * The Session list's own notices only apply while the list is on screen; a phone showing a Session detail keeps just
 * the app-wide connection and update ones.
 */
const LIST_ONLY_NOTICES: ReadonlySet<HomeNoticeKind> = new Set([
    'list-error',
    'saved-copy',
    'truncated',
]);

/**
 * Picks the single notice to draw. `update` is the Mobile update banner's kind: a version mismatch that offers no build
 * (`mismatch`) or one that does (`required`, `checking`, `unreachable`) outranks everything because the app cannot
 * reconnect until it is resolved; an optional update (`available`) yields to any connection or list problem.
 */
export const selectHomeNotice = ({
    connection,
    isListVisible,
    isListErrorShown,
    isSavedCopy,
    isTruncated,
    update,
}: {
    connection: 'stale' | 'unverified' | null;
    isListErrorShown: boolean;
    isListVisible: boolean;
    isSavedCopy: boolean;
    isTruncated: boolean;
    update: 'available' | 'checking' | 'mismatch' | 'required' | 'unreachable' | null;
}): HomeNoticeKind | null => {
    const active = new Set<HomeNoticeKind>();
    if (update === 'mismatch') active.add('update-mismatch');
    else if (update === 'available') active.add('update-available');
    else if (update !== null) active.add('update-required');
    if (connection) active.add(`connection-${connection}`);
    if (isListErrorShown) active.add('list-error');
    if (isSavedCopy) active.add('saved-copy');
    if (isTruncated) active.add('truncated');
    return (
        HOME_NOTICE_PRIORITY.find(
            (kind) => active.has(kind) && (isListVisible || !LIST_ONLY_NOTICES.has(kind)),
        ) ?? null
    );
};
