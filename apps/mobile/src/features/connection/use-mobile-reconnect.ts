import { useEffect } from 'react';

import type { MobileConnectionStatus } from './connection-state';
import { reconnectDelay } from './connection-state';
import type { MobileCredential } from './credential-store';
import type { MobileGatewayConnection } from './mobile-gateway-client';
import { reconnectWaitForAttempt, runReconnectAttempt } from './reconnect-lifecycle';

export const shouldScheduleMobileReconnect = (
    credential: MobileCredential | null,
    status: MobileConnectionStatus,
): credential is MobileCredential => credential !== null && status === 'stale';

export const useMobileReconnect = ({
    connect,
    credential,
    onConnected,
    onFailed,
    retryAttempt,
    status,
}: {
    connect: (credential: MobileCredential) => Promise<MobileGatewayConnection>;
    credential: MobileCredential | null;
    onConnected: (connection: MobileGatewayConnection) => void;
    onFailed: () => void;
    retryAttempt: number;
    status: MobileConnectionStatus;
}): void => {
    useEffect(() => {
        if (!shouldScheduleMobileReconnect(credential, status)) return;
        let isActive = true;
        const timer = setTimeout(
            () => {
                // eslint-disable-next-line no-void -- The timeout owns this bounded reconnect attempt.
                void runReconnectAttempt({
                    connect: () => connect(credential),
                    isActive: () => isActive,
                    onConnected,
                    onFailed,
                });
            },
            reconnectWaitForAttempt(retryAttempt, reconnectDelay),
        );
        return () => {
            isActive = false;
            clearTimeout(timer);
        };
    }, [connect, credential, onConnected, onFailed, retryAttempt, status]);
};
