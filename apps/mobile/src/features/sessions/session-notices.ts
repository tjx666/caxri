import type { MobileConnectionStatus } from '../connection/connection-state';

/**
 * Whether the app-wide connection banner explains the screen. A version mismatch has its own update banner instead.
 */
export const isConnectionBannerShown = (
    isFresh: boolean,
    status: MobileConnectionStatus,
): boolean => !isFresh && status !== 'version-mismatch';

/**
 * The connection banner's copy. When the screen already labels its saved copy (`Showing Sessions saved 5m ago.`), the
 * banner only says why it is not live, so the two notices never both say what is being shown.
 */
export const connectionBannerCopy = (
    status: 'stale' | 'unverified',
    isSavedCopyLabeled: boolean,
): { title: string; body: string; accessibilityLabel: string } => {
    if (status === 'unverified') {
        const body = 'If this device was revoked on your computer, forget it and pair again.';
        return {
            title: 'Pairing could not be verified',
            body,
            accessibilityLabel: `This pairing could not be verified. ${body}`,
        };
    }
    const body = isSavedCopyLabeled
        ? 'Replies are paused until Caxri reconnects.'
        : 'Showing the last known state. Replies are paused.';
    return { title: 'Reconnecting…', body, accessibilityLabel: `Connection interrupted. ${body}` };
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
