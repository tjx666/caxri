import type { MobileSubscriptionResource } from '@caxri/mobile-transport';

import type { MobileSubscriptionListener } from './mobile-frame-router';
import type {
    MobileGatewayConnection,
    MobileGatewaySubscriptionHandle,
} from './mobile-gateway-connection';

/**
 * Subscribes on `connection` and keeps the lease only while that connection is still the owner's current one.
 */
export const acquireMobileSubscription = async ({
    currentConnection,
    connection,
    listener,
    resource,
}: {
    currentConnection: () => MobileGatewayConnection | null;
    connection: MobileGatewayConnection;
    listener: MobileSubscriptionListener;
    resource: MobileSubscriptionResource;
}): Promise<MobileGatewaySubscriptionHandle> => {
    const handle = await connection.subscribe(resource, listener);
    if (currentConnection() === connection) return handle;
    try {
        await handle.unsubscribe();
    } catch {
        // The old connection may already be closed; the lease must not escape to the new owner.
    }
    throw new Error('Caxri is reconnecting.');
};
