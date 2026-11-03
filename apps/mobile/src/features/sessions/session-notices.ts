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
 * Every notice that applies, most severe first. `update` is the Mobile update banner's kind: a version mismatch that
 * offers no build (`mismatch`) or one that does (`required`, `checking`, `unreachable`) outranks everything because the
 * app cannot reconnect until it is resolved; an optional update (`available`) yields to any connection or list
 * problem.
 */
export const homeNoticeCandidates = ({
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
}): HomeNoticeKind[] => {
    const active = new Set<HomeNoticeKind>();
    if (update === 'mismatch') active.add('update-mismatch');
    else if (update === 'available') active.add('update-available');
    else if (update !== null) active.add('update-required');
    if (connection) active.add(`connection-${connection}`);
    if (isListErrorShown) active.add('list-error');
    if (isSavedCopy) active.add('saved-copy');
    if (isTruncated) active.add('truncated');
    return HOME_NOTICE_PRIORITY.filter(
        (kind) => active.has(kind) && (isListVisible || !LIST_ONLY_NOTICES.has(kind)),
    );
};

/**
 * The single notice to draw: the most severe of {@link homeNoticeCandidates}.
 */
export const selectHomeNotice = (
    input: Parameters<typeof homeNoticeCandidates>[0],
): HomeNoticeKind | null => homeNoticeCandidates(input)[0] ?? null;

/**
 * How long a notice must stay selected before it takes space at the top of Session home.
 */
export const HOME_NOTICE_SETTLE_MS = 2_000;

/**
 * Notices that usually clear on their own within a moment. On a cold start the connection is `connecting` for a few
 * hundred milliseconds (`connection-stale`), then the list is still the saved copy until the first live list lands
 * (`saved-copy`); drawing each at once pushed the list down and back up twice. Every other notice needs the user or
 * reports a lasting fact, so it shows at once.
 */
const SELF_CLEARING_NOTICES: ReadonlySet<HomeNoticeKind> = new Set([
    'connection-stale',
    'saved-copy',
]);

/**
 * The delay before `kind` appears: {@link HOME_NOTICE_SETTLE_MS} for a self-clearing notice, otherwise `0`. Hiding a
 * notice is never delayed.
 */
export const homeNoticeSettleDelay = (kind: HomeNoticeKind | null): number =>
    kind !== null && SELF_CLEARING_NOTICES.has(kind) ? HOME_NOTICE_SETTLE_MS : 0;

/**
 * What Session home draws while the most severe candidate is still waiting out its settle delay: the most severe
 * candidate that needs no delay. Without it, an update offer already on screen vanished the moment a reconnect selected
 * the (not yet drawn) Reconnecting notice above it, and came back once the connection returned.
 */
export const waitingHomeNotice = (candidates: readonly HomeNoticeKind[]): HomeNoticeKind | null =>
    candidates.find((kind) => homeNoticeSettleDelay(kind) === 0) ?? null;

/**
 * When each self-clearing notice was first selected by any mounted screen, shared across screens. Opening a Session on
 * a phone mounts a second Sessions screen; without this, a notice already on screen would wait out the delay again
 * there and drop in late, the very shift the delay exists to avoid.
 */
export interface HomeNoticeSelections {
    /**
     * Records one more screen selecting `kind` and returns when it was first selected.
     */
    acquire: (kind: HomeNoticeKind, now: number) => number;
    /**
     * The time `kind` was first selected while some screen still selects it, otherwise `null`.
     */
    since: (kind: HomeNoticeKind) => number | null;
    /**
     * Records one screen no longer selecting `kind`; the last release forgets its start.
     */
    release: (kind: HomeNoticeKind) => void;
}

export const createHomeNoticeSelections = (): HomeNoticeSelections => {
    const entries = new Map<HomeNoticeKind, { count: number; since: number }>();
    return {
        acquire: (kind, now) => {
            const entry = entries.get(kind) ?? { count: 0, since: now };
            entry.count += 1;
            entries.set(kind, entry);
            return entry.since;
        },
        since: (kind) => entries.get(kind)?.since ?? null,
        release: (kind) => {
            const entry = entries.get(kind);
            if (!entry) return;
            entry.count -= 1;
            if (entry.count <= 0) entries.delete(kind);
        },
    };
};
