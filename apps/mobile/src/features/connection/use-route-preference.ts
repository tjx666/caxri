import { useCallback, useEffect, useState } from 'react';

import type { MobileClientCloseReason } from '@caxri/mobile-transport';

import { expoMobileGatewayRuntime } from './expo-mobile-gateway-runtime';
import type { MobileGatewayConnection } from './mobile-gateway-connection';
import type { MobileRoutePreference } from './route-preference';
import { DEFAULT_MOBILE_ROUTE_PREFERENCE, isRouteAllowedByPreference } from './route-preference';

/**
 * The connection method chosen in Settings. Reconnects read the stored choice themselves (see
 * `reconnectMobileGateway`); this hook only mirrors it for the UI and restarts a live connection that took a path the
 * new choice excludes, instead of waiting for its next drop. A mutation awaiting its reply defers that restart like a
 * foreground return does, so its outcome is never lost.
 */
export const useRoutePreference = ({
    currentConnection,
    deferRestart,
    isPaired,
    restartConnection,
}: {
    currentConnection: () => MobileGatewayConnection | null;
    /**
     * Restarts once the outstanding mutation settles.
     */
    deferRestart: () => void;
    isPaired: boolean;
    restartConnection: (reason: MobileClientCloseReason) => void;
}) => {
    const [routePreference, setRoutePreferenceState] = useState<MobileRoutePreference>(
        DEFAULT_MOBILE_ROUTE_PREFERENCE,
    );
    useEffect(() => {
        let isActive = true;
        void expoMobileGatewayRuntime.routePreference?.load().then((stored) => {
            if (isActive) setRoutePreferenceState(stored);
        });
        return () => {
            isActive = false;
        };
    }, []);
    const setRoutePreference = useCallback(
        async (next: MobileRoutePreference): Promise<void> => {
            setRoutePreferenceState(next);
            try {
                await expoMobileGatewayRuntime.routePreference?.save(next);
            } catch {
                // The store keeps the choice in memory, so it still governs reconnects until the app restarts.
            }
            const current = currentConnection();
            if (!isPaired || !current || isRouteAllowedByPreference(current.route, next)) return;
            if (current.hasOutstandingMutation()) {
                deferRestart();
                return;
            }
            restartConnection('route-preference');
        },
        [currentConnection, deferRestart, isPaired, restartConnection],
    );
    return { routePreference, setRoutePreference };
};
