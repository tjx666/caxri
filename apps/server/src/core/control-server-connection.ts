import type { ClientState, ControlServerOptions } from './control-server-support';

/**
 * Marks a closed connection's state and reports each request that never got a reply to the disconnect observer.
 */
export function abandonControlRequests(
    state: ClientState,
    options: Pick<ControlServerOptions, 'onRequestDisconnected'>,
): void {
    for (const requestId of state.inFlightRequestIds.keys())
        options.onRequestDisconnected?.(requestId, state.context);
    state.inFlightRequestIds.clear();
    state.closed = true;
    state.inFlightRequests = 0;
}
