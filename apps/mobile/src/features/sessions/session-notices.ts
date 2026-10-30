import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';
import type { MobileRelayFailureKind } from '../connection/relay-failure';

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
    relayFailure: MobileRelayFailureKind | null = null,
): string => {
    if (status === 'unverified') return t('sessions.banner.unverified');
    if (relayFailure === 'host-offline') return t('sessions.banner.hostOffline');
    if (relayFailure === 'unauthorized') return t('sessions.banner.relayUnauthorized');
    if (relayFailure === 'busy') return t('sessions.banner.relayBusy');
    return savedLabel === null
        ? t('sessions.banner.stale')
        : t('sessions.banner.staleSaved', { saved: savedLabel });
};

/**
 * What the connection banner draws besides its sentence: the tone and the one action that can help. A stale connection
 * retries on a backoff of up to 30 seconds, so `reconnect` skips the wait; a Relay that does not accept this phone
 * cannot be fixed by retrying, so `settings` opens where the user can forget the computer and pair again. A busy Relay
 * keeps its muted tone because the app is already retrying and nothing needs the user.
 */
export const connectionBannerModel = (
    status: 'stale' | 'unverified',
    relayFailure: MobileRelayFailureKind | null = null,
): {
    action: 'reconnect' | 'retry' | 'settings';
    tone: 'muted' | 'warning';
} => {
    if (status === 'unverified') return { action: 'retry', tone: 'warning' };
    if (relayFailure === 'unauthorized') return { action: 'settings', tone: 'warning' };
    if (relayFailure === 'host-offline') return { action: 'reconnect', tone: 'warning' };
    return { action: 'reconnect', tone: 'muted' };
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
