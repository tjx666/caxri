import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';
import type { MobileRelayFailureKind } from '../connection/relay-failure';
import type { MobileRoutePreference } from '../connection/route-preference';

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
 * What the connection notice draws besides its sentence: the tone, the one action that can help, and where it sits. A
 * stale connection retries on a backoff of up to 30 seconds, so `reconnect` skips the wait; a Relay that does not
 * accept this phone cannot be fixed by retrying, so `settings` opens where the user can forget the computer and pair
 * again. A busy Relay keeps its muted tone because the app is already retrying and nothing needs the user.
 *
 * `island` is the floating capsule over the top of the screen: an automatic reconnect needs nothing from the user and
 * clears by itself, so it must not take layout height and push the list down and back up. A notice the user has to act
 * on stays a `banner` the screen makes room for.
 */
export const connectionBannerModel = (
    status: 'stale' | 'unverified',
    relayFailure: MobileRelayFailureKind | null = null,
    pinnedRoute: PinnedRoute | null = null,
    hasReconnectPersisted = false,
): {
    action: 'reconnect' | 'retry' | 'settings';
    presentation: 'banner' | 'island';
    tone: 'muted' | 'warning';
} => {
    if (status === 'unverified')
        return { action: 'retry', presentation: 'banner', tone: 'warning' };
    if (relayFailure === 'unauthorized')
        return { action: 'settings', presentation: 'banner', tone: 'warning' };
    if (relayFailure === 'host-offline')
        return { action: 'reconnect', presentation: 'banner', tone: 'warning' };
    // A pinned path cannot fall back to the other one, so a reconnect that keeps failing is fixed in Settings.
    if (pinnedRoute !== null && hasReconnectPersisted)
        return { action: 'settings', presentation: 'island', tone: 'muted' };
    return { action: 'reconnect', presentation: 'island', tone: 'muted' };
};

/**
 * A connection method the user pinned; `auto` is not pinned because it races both paths.
 */
export type PinnedRoute = Exclude<MobileRoutePreference, 'auto'>;

export const pinnedRouteOf = (preference: MobileRoutePreference): PinnedRoute | null =>
    preference === 'auto' ? null : preference;

/**
 * How long a pinned connection keeps reconnecting before the capsule offers the connection method setting.
 */
export const PINNED_RECONNECT_PERSIST_MS = 15_000;

/**
 * The connection island's short label: the state in a few words, plus the saved copy's age when the Session list on
 * screen is that copy. The island's accessible name still reads `connectionNoticeMessage`'s full sentence.
 */
export const connectionIslandLabel = (
    savedLabel: string | null,
    t: Translate = translate,
    relayFailure: MobileRelayFailureKind | null = null,
    pinnedRoute: PinnedRoute | null = null,
): string => {
    if (relayFailure === 'busy') return t('sessions.banner.relayBusyShort');
    const label =
        savedLabel === null
            ? t('sessions.banner.reconnecting')
            : t('sessions.banner.reconnectingSaved', { saved: savedLabel });
    // Names the pinned method so the user can tell why the app does not switch to the other path.
    if (pinnedRoute === null) return label;
    const method = t(
        pinnedRoute === 'direct' ? 'sessions.banner.pinnedDirect' : 'sessions.banner.pinnedRelay',
    );
    return t('sessions.banner.pinned', { label, method });
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
 * How long a self-clearing notice must stay selected before it takes space at the top of Session home.
 */
export const HOME_NOTICE_SETTLE_MS = 2_000;

/**
 * The settle delay of the Reconnecting notice, matching the age at which a silent connection counts as stale
 * (`CONNECTION_STALE_AFTER_MS`). Returning from the background on a mobile network routinely takes two to three seconds
 * to reconnect; with {@link HOME_NOTICE_SETTLE_MS} the notice dropped in just before the connection came back and
 * vanished half a second later, pushing the list down and up on every resume.
 */
export const CONNECTION_NOTICE_SETTLE_MS = 5_000;

/**
 * How long a self-clearing notice already on screen stays after it stops being selected. On a flaky network the
 * connection recovers for a moment and drops again; hiding at once and waiting out the settle delay again drew the
 * banner in and out repeatedly, shifting the list each time. Within this window a notice selected again simply stays.
 */
export const HOME_NOTICE_HOLD_MS = 3_000;

/**
 * Notices that usually clear on their own within a moment, with their settle delay. On a cold start the connection is
 * `connecting` for a few hundred milliseconds (`connection-stale`), then the list is still the saved copy until the
 * first live list lands (`saved-copy`); drawing each at once pushed the list down and back up twice. Every other notice
 * needs the user or reports a lasting fact, so it shows at once.
 */
const SELF_CLEARING_NOTICE_DELAYS: ReadonlyMap<HomeNoticeKind, number> = new Map([
    ['connection-stale', CONNECTION_NOTICE_SETTLE_MS],
    ['saved-copy', HOME_NOTICE_SETTLE_MS],
]);

/**
 * The delay before `kind` appears: its self-clearing settle delay, otherwise `0`. A drawn self-clearing notice hides
 * only after {@link HOME_NOTICE_HOLD_MS}; any other notice hides at once.
 */
export const homeNoticeSettleDelay = (kind: HomeNoticeKind | null): number =>
    (kind === null ? undefined : SELF_CLEARING_NOTICE_DELAYS.get(kind)) ?? 0;

/**
 * What Session home draws while the most severe candidate is still waiting out its settle delay: the most severe
 * candidate that needs no delay. Without it, an update offer already on screen vanished the moment a reconnect selected
 * the (not yet drawn) Reconnecting notice above it, and came back once the connection returned.
 */
export const waitingHomeNotice = (candidates: readonly HomeNoticeKind[]): HomeNoticeKind | null =>
    candidates.find((kind) => homeNoticeSettleDelay(kind) === 0) ?? null;

/**
 * What Session home draws given the most severe candidate's settle state and a self-clearing notice still held on
 * screen. A notice that needs no delay always wins at once. Otherwise a settled candidate is drawn; failing that, a
 * held notice keeps its place so a brief recovery does not collapse the bar; failing that, the most severe candidate
 * that needs no wait ({@link waitingHomeNotice}).
 */
export const drawnHomeNotice = ({
    candidates,
    held,
    settled,
}: {
    candidates: readonly HomeNoticeKind[];
    /**
     * A self-clearing notice that was on screen and is inside its {@link HOME_NOTICE_HOLD_MS} window, or `null`.
     */
    held: HomeNoticeKind | null;
    /**
     * The self-clearing notice that has waited out its settle delay, or `null`.
     */
    settled: HomeNoticeKind | null;
}): HomeNoticeKind | null => {
    const kind = candidates.at(0) ?? null;
    if (kind !== null && homeNoticeSettleDelay(kind) === 0) return kind;
    if (kind !== null && settled === kind) return kind;
    if (held !== null) return held;
    return waitingHomeNotice(candidates);
};

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

/**
 * How long the truncated-list island stays up. Truncation is a lasting fact rather than something that clears itself,
 * so a capsule held for as long as it is true would cover the header for good; it shows once and gets out of the way.
 */
export const TRUNCATED_NOTICE_VISIBLE_MS = 4_000;

/**
 * When each transient notice was first drawn in this app process. A notice drawn again for the same key (another screen
 * mounting, or a higher notice clearing above it) only gets what is left of its time, so the truncated island does not
 * return every time the Session list comes back into view. A new count is a new key and shows again.
 */
export const createFirstShownTimes = (): ((key: string, now: number) => number) => {
    const times = new Map<string, number>();
    return (key, now) => {
        const since = times.get(key) ?? now;
        times.set(key, since);
        return since;
    };
};

/**
 * How many milliseconds a transient notice first drawn at `since` still has on screen; `0` once it has expired.
 */
export const transientNoticeRemainingMs = (
    since: number,
    now: number,
    durationMs: number = TRUNCATED_NOTICE_VISIBLE_MS,
): number => Math.max(0, since + durationMs - now);
