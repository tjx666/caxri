import { caxri } from '../../lib/caxri';

/**
 * Best effort by design: the Server throttles this per Session and publishes the result through the usual change
 * events, so a failed request only leaves the regular delivery polls in charge.
 */
export async function requestDeliveryFocusRefresh(sessionId: string): Promise<void> {
    try {
        await caxri.request('session.refreshDeliveryOnFocus', { sessionId });
    } catch {
        // Intentionally ignored, see above.
    }
}
