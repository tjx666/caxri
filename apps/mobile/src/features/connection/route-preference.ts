/**
 * The user's choice of network path to the paired computer. `auto` races direct addresses and the Relay (see
 * `openGatewaySocket`) and moves a Relay session back to a direct path once one answers; `direct` and `relay` pin the
 * path, so neither a race nor the direct-route probe switches it.
 */
import type { MobileGatewayRoute, MobileGatewayRouteKind } from './gateway-routes';

export const mobileRoutePreferences = ['auto', 'direct', 'relay'] as const;

export type MobileRoutePreference = (typeof mobileRoutePreferences)[number];

export const DEFAULT_MOBILE_ROUTE_PREFERENCE: MobileRoutePreference = 'auto';

/**
 * The routes a reconnect may race. A pinned path the pairing does not offer, such as `relay` for a computer without a
 * Relay, falls back to every route rather than leaving the phone unable to connect; the Status row still shows which
 * path won.
 */
export const routesForPreference = (
    routes: readonly MobileGatewayRoute[],
    preference: MobileRoutePreference,
): MobileGatewayRoute[] => {
    if (preference === 'auto') return [...routes];
    const pinned = routes.filter((route) => route.kind === preference);
    return pinned.length > 0 ? pinned : [...routes];
};

/**
 * Whether a live connection over `route` already honors `preference`, so changing the preference needs no reconnect.
 */
export const isRouteAllowedByPreference = (
    route: MobileGatewayRouteKind,
    preference: MobileRoutePreference,
): boolean => preference === 'auto' || preference === route;

export interface MobileRoutePreferenceStore {
    load(): Promise<MobileRoutePreference>;
    save(preference: MobileRoutePreference): Promise<void>;
}

interface RoutePreferenceStorage {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

const ROUTE_PREFERENCE_KEY = 'caxri.mobile-route-preference.v1';

const isRoutePreference = (value: unknown): value is MobileRoutePreference =>
    mobileRoutePreferences.includes(value as MobileRoutePreference);

/**
 * Keeps the choice in memory and mirrors it to storage. An unreadable or unknown stored value reads as `auto`, the
 * behavior the phone had before the choice existed.
 */
export const createMobileRoutePreferenceStore = (
    storage: RoutePreferenceStorage,
): MobileRoutePreferenceStore => {
    let cached: MobileRoutePreference | undefined;
    return {
        load: async () => {
            if (cached) return cached;
            try {
                const stored = await storage.getItemAsync(ROUTE_PREFERENCE_KEY);
                cached = isRoutePreference(stored) ? stored : DEFAULT_MOBILE_ROUTE_PREFERENCE;
            } catch {
                return DEFAULT_MOBILE_ROUTE_PREFERENCE;
            }
            return cached;
        },
        save: async (preference) => {
            cached = preference;
            await storage.setItemAsync(ROUTE_PREFERENCE_KEY, preference);
        },
    };
};
