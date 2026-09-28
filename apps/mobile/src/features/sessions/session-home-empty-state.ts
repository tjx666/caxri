import type { MobileConnectionStatus } from '../connection/connection-state';

interface SessionHomeEmptyState {
    action: 'new' | 'retry' | null;
    body: string;
    showSpinner: boolean;
    testID: string;
    title: string | null;
    titleRole?: 'alert' | 'header';
}

export const describeSessionHomeEmptyState = ({
    activeProjectId,
    error,
    hasLoaded,
    status,
}: {
    activeProjectId: string | null;
    error: string | null;
    hasLoaded: boolean;
    status: MobileConnectionStatus;
}): SessionHomeEmptyState => {
    if (hasLoaded)
        return {
            action: 'new',
            body: activeProjectId
                ? 'Choose another Project or start a Session here.'
                : 'Start one here or on your computer.',
            showSpinner: false,
            testID: 'session-list-empty',
            title: activeProjectId ? 'No Sessions in this Project' : 'No Sessions yet',
        };
    if (status === 'version-mismatch')
        return {
            action: null,
            // The banner above says which side to update; this body must stay true for either answer.
            body: 'Sessions appear once this app and Caxri on your computer match.',
            showSpinner: false,
            testID: 'session-list-version-mismatch',
            title: 'Update required',
            titleRole: 'header',
        };
    if (status === 'unverified')
        return {
            action: null,
            body: 'Retry the connection, or forget this device and pair again.',
            showSpinner: false,
            testID: 'session-list-unverified',
            title: 'Sessions unavailable',
            titleRole: 'header',
        };
    if (error)
        return {
            action: 'retry',
            body: 'Check the Mac connection, then try again.',
            showSpinner: false,
            testID: 'session-list-error',
            title: 'Unable to load Sessions',
            titleRole: 'alert',
        };
    return {
        action: null,
        body: 'Loading Sessions…',
        showSpinner: true,
        testID: 'session-list-loading',
        title: null,
    };
};
