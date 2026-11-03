import { useEffect } from 'react';

import { useOnVisible } from '../../../hooks/use-on-visible';
import { useSelectedSessionId } from '../../../stores/selectors';
import { requestDeliveryFocusRefresh } from '../delivery-focus-refresh-client';

/**
 * Asks the Server to re-read the selected Session's pull request and delivery status whenever the window regains focus
 * or the user switches to another Session, so a pull request merged in the browser stops showing as open the moment the
 * user looks at it again.
 *
 * Refetching the Renderer queries alone is not enough: they read Server caches that hold a settled pull request for
 * minutes. See `DeliveryFocusRefresh` on the Server for the per-Session throttle that keeps rapid switching from
 * spending extra `gh` queries, and for the refresh order.
 */
export function useDeliveryFocusRefresh(): void {
    const sessionId = useSelectedSessionId();
    useOnVisible(() => {
        // Fire-and-forget: the client swallows failures and the change events deliver the result.
        if (sessionId) void requestDeliveryFocusRefresh(sessionId);
    });
    useEffect(() => {
        if (sessionId) void requestDeliveryFocusRefresh(sessionId);
    }, [sessionId]);
}
