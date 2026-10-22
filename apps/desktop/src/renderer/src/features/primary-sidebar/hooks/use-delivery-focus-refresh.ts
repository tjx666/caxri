import { useOnVisible } from '../../../hooks/use-on-visible';
import { useSelectedSessionId } from '../../../stores/selectors';
import { requestDeliveryFocusRefresh } from '../delivery-focus-refresh-client';

/**
 * Asks the Server to re-read the selected Session's pull request and delivery status whenever the window regains focus,
 * so a pull request merged in the browser stops showing as open the moment the user switches back.
 *
 * Refetching the Renderer queries alone is not enough: they read Server caches that hold a settled pull request for
 * minutes. See `DeliveryFocusRefresh` on the Server for the throttle and the refresh order.
 */
export function useDeliveryFocusRefresh(): void {
    const sessionId = useSelectedSessionId();
    useOnVisible(() => {
        // Fire-and-forget: the client swallows failures and the change events deliver the result.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        if (sessionId) void requestDeliveryFocusRefresh(sessionId);
    });
}
