/**
 * Remembers which route last reached each paired computer. A phone that reached it through the Relay last time is
 * probably still away from home, so its next reconnect gives direct addresses a short head start instead of the full
 * grace (see `directRouteGraceFor`).
 */
import type { MobileGatewayRouteKind } from './gateway-routes';
import { directRouteGraceFor } from './gateway-routes';

export interface MobileRouteHints {
    load(serverId: string): Promise<MobileGatewayRouteKind | undefined>;
    save(serverId: string, route: MobileGatewayRouteKind): void;
}

interface RouteHintStorage {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

const ROUTE_HINT_KEY = 'caxri.mobile-route-hint.v1';

/**
 * Keeps the hint in memory and mirrors it to storage so it survives the app process being killed in the background. A
 * storage failure only costs the full grace on the next cold start, so it is ignored.
 */
export const createMobileRouteHints = (storage: RouteHintStorage): MobileRouteHints => {
    let cached: { route: MobileGatewayRouteKind; serverId: string } | undefined;
    return {
        load: async (serverId) => {
            if (!cached) {
                try {
                    const stored = await storage.getItemAsync(ROUTE_HINT_KEY);
                    const parsed = stored ? (JSON.parse(stored) as unknown) : undefined;
                    if (
                        parsed &&
                        typeof parsed === 'object' &&
                        'serverId' in parsed &&
                        'route' in parsed &&
                        typeof parsed.serverId === 'string' &&
                        (parsed.route === 'direct' || parsed.route === 'relay')
                    )
                        cached = { serverId: parsed.serverId, route: parsed.route };
                } catch {
                    // Unreadable storage falls back to the full grace.
                }
            }
            return cached?.serverId === serverId ? cached.route : undefined;
        },
        save: (serverId, route) => {
            if (cached?.serverId === serverId && cached.route === route) return;
            cached = { serverId, route };
            void storage.setItemAsync(ROUTE_HINT_KEY, JSON.stringify(cached)).catch(() => {});
        },
    };
};

/**
 * The direct-only head start for one reconnect. A failed network probe reads as not cellular, so it only costs the full
 * grace.
 */
export const reconnectDirectGrace = async (input: {
    addresses: readonly string[];
    isCellular?: () => Promise<boolean>;
    routeHints?: MobileRouteHints;
    serverId: string;
}): Promise<number> => {
    const [lastRoute, isCellular] = await Promise.all([
        input.routeHints?.load(input.serverId),
        (async () => {
            try {
                return (await input.isCellular?.()) ?? false;
            } catch {
                return false;
            }
        })(),
    ]);
    return directRouteGraceFor({ addresses: input.addresses, isCellular, lastRoute });
};
