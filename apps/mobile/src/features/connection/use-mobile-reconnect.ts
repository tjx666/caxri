import { useEffect } from 'react';

import type { MobileConnectionStatus } from './connection-state';
import { reconnectDelay } from './connection-state';
import type { MobileCredential } from './credential-store';
import type { MobileGatewayConnection } from './mobile-gateway-connection';
import { reconnectWaitForAttempt, runReconnectAttempt } from './reconnect-lifecycle';

export const shouldScheduleMobileReconnect = (
    credential: MobileCredential | null,
    status: MobileConnectionStatus,
    isForeground = true,
): credential is MobileCredential => credential !== null && status === 'stale' && isForeground;

export const useMobileReconnect = ({
    connect,
    credential,
    isForeground,
    onConnected,
    onFailed,
    retryToken,
    retryAttempt,
    status,
}: {
    connect: (credential: MobileCredential) => Promise<MobileGatewayConnection>;
    credential: MobileCredential | null;
    isForeground: boolean;
    onConnected: (connection: MobileGatewayConnection) => void;
    onFailed: (error: unknown) => void;
    retryToken: number;
    retryAttempt: number;
    status: MobileConnectionStatus;
}): void => {
    useEffect(() => {
        if (!shouldScheduleMobileReconnect(credential, status, isForeground)) return;
        let isActive = true;
        const timer = setTimeout(
            () => {
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
    }, [
        connect,
        credential,
        isForeground,
        onConnected,
        onFailed,
        retryAttempt,
        retryToken,
        status,
    ]);
};
