import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';

interface SessionHomeEmptyState {
    action: 'new' | 'retry' | null;
    body: string;
    showSpinner: boolean;
    testID: string;
    title: string | null;
    titleRole?: 'alert' | 'header';
}

export const describeSessionHomeEmptyState = (
    {
        activeProjectId,
        error,
        hasLoaded,
        status,
    }: {
        activeProjectId: string | null;
        error: string | null;
        hasLoaded: boolean;
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
    return {
        action: null,
        body: t('sessions.home.loading'),
        showSpinner: true,
        testID: 'session-list-loading',
        title: null,
    };
};
