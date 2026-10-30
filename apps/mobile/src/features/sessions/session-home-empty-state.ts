import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';

interface SessionHomeEmptyState {
    action: 'new' | 'reconnect' | 'retry' | null;
    body: string;
    showSpinner: boolean;
    testID: string;
    title: string | null;
    titleRole?: 'alert' | 'header';
}

/**
 * How long the first Session read may stay silent while the connection is stale or connecting before the home stops
 * promising a list and says the computer is unreachable.
 */
export const SESSION_LOAD_STALL_MS = 8_000;

/**
 * Whether the first Session read is still waiting on a connection that is down or being dialed: the only situation in
 * which silence can mean the computer is unreachable, so the only one the stall timer runs in.
 */
export const isAwaitingFirstLoad = (status: MobileConnectionStatus, hasLoaded: boolean): boolean =>
    !hasLoaded && (status === 'stale' || status === 'connecting');

export const describeSessionHomeEmptyState = (
    {
        activeProjectId,
        error,
        hasLoaded,
        isStalled = false,
        status,
    }: {
        activeProjectId: string | null;
        error: string | null;
        hasLoaded: boolean;
        /**
         * The first load has waited past {@link SESSION_LOAD_STALL_MS} while the connection is down.
         */
        isStalled?: boolean;
        status: MobileConnectionStatus;
    },
    t: Translate = translate,
): SessionHomeEmptyState => {
    if (hasLoaded)
        return {
            action: 'new',
            body: t(activeProjectId ? 'sessions.home.emptyProjectBody' : 'sessions.home.emptyBody'),
            showSpinner: false,
            testID: 'session-list-empty',
            title: t(
                activeProjectId ? 'sessions.home.emptyProjectTitle' : 'sessions.home.emptyTitle',
            ),
        };
    if (status === 'version-mismatch')
        return {
            action: null,
            // The banner above says which side to update; this body must stay true for either answer.
            body: t('sessions.home.versionMismatchBody'),
            showSpinner: false,
            testID: 'session-list-version-mismatch',
            title: t('sessions.home.versionMismatchTitle'),
            titleRole: 'header',
        };
    if (status === 'unverified')
        return {
            action: null,
            body: t('sessions.home.unverifiedBody'),
            showSpinner: false,
            testID: 'session-list-unverified',
            title: t('sessions.home.unverifiedTitle'),
            titleRole: 'header',
        };
    if (error)
        return {
            action: 'retry',
            body: t('sessions.home.errorBody'),
            showSpinner: false,
            testID: 'session-list-error',
            title: t('sessions.home.errorTitle'),
            titleRole: 'alert',
        };
    if (isStalled)
        return {
            action: 'reconnect',
            body: t('sessions.home.unreachableBody'),
            showSpinner: false,
            testID: 'session-list-unreachable',
            title: t('sessions.home.unreachableTitle'),
            titleRole: 'alert',
        };
    return {
        action: null,
        body: t('sessions.home.loading'),
        showSpinner: true,
        testID: 'session-list-loading',
        title: null,
    };
};
