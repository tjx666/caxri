import type { ReactNode } from 'react';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import * as Device from 'expo-device';

import type { MobileConnectionStatus } from './connection-state';
import type { MobileCredential } from './credential-store';
import { expoMobileCredentialStore } from './expo-credential-store';
import { expoMobileGatewayRuntime } from './expo-mobile-gateway-runtime';
import type { MobileGatewayConnection } from './mobile-gateway-client';
import {
    MobileGatewayRequestError,
    pairMobileGateway,
    reconnectMobileGateway,
} from './mobile-gateway-client';
import { useMobileReconnect } from './use-mobile-reconnect';

interface MobileClientContextValue {
    forgetDevice: () => Promise<void>;
    lastSeenAt: number | null;
    pair: (pairingLink: string) => Promise<void>;
    paired: boolean;
    request: <M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => Promise<MethodResult<M>>;
    status: MobileConnectionStatus;
}

const MobileClientContext = createContext<MobileClientContextValue | null>(null);

export const MobileClientProvider = ({ children }: { children: ReactNode }) => {
    const [credential, setCredential] = useState<MobileCredential | null>(null);
    const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
    const [retryAttempt, setRetryAttempt] = useState(0);
    const [status, setStatus] = useState<MobileConnectionStatus>('booting');
    const connection = useRef<MobileGatewayConnection | null>(null);

    const replaceConnection = useCallback((next: MobileGatewayConnection | null): void => {
        if (connection.current !== next) connection.current?.close();
        connection.current = next;
    }, []);

    useEffect(() => {
        let isActive = true;
        const loadCredential = async (): Promise<void> => {
            try {
                const stored = await expoMobileCredentialStore.load();
                if (!isActive) return;
                setCredential(stored);
                setStatus(stored ? 'stale' : 'unpaired');
            } catch {
                if (isActive) setStatus('unpaired');
            }
        };
        // eslint-disable-next-line no-void -- React effects cannot return the credential-loading promise.
        void loadCredential();
        return () => {
            isActive = false;
            replaceConnection(null);
        };
    }, [replaceConnection]);

    const reconnect = useCallback(
        (storedCredential: MobileCredential) =>
            reconnectMobileGateway(storedCredential, expoMobileGatewayRuntime),
        [],
    );
    const acceptReconnection = useCallback(
        (next: MobileGatewayConnection): void => {
            replaceConnection(next);
            setLastSeenAt(Date.now());
            setRetryAttempt(0);
            setStatus('connected');
        },
        [replaceConnection],
    );
    const rejectReconnection = useCallback((): void => {
        setRetryAttempt((attempt) => attempt + 1);
        setStatus('stale');
    }, []);
    useMobileReconnect({
        connect: reconnect,
        credential,
        onConnected: acceptReconnection,
        onFailed: rejectReconnection,
        retryAttempt,
        status,
    });

    const pair = useCallback(
        async (pairingLink: string): Promise<void> => {
            replaceConnection(null);
            setStatus('connecting');
            try {
                const paired = await pairMobileGateway({
                    displayName: Device.modelName ?? 'Mobile device',
                    pairingLink,
                    runtime: expoMobileGatewayRuntime,
                    store: expoMobileCredentialStore,
                });
                setCredential(paired.credential);
                replaceConnection(paired.connection);
                setLastSeenAt(Date.now());
                setRetryAttempt(0);
                setStatus('connected');
            } catch (error) {
                setStatus(credential ? 'stale' : 'unpaired');
                throw error;
            }
        },
        [credential, replaceConnection],
    );

    const forgetDevice = useCallback(async (): Promise<void> => {
        replaceConnection(null);
        await expoMobileCredentialStore.clear();
        setCredential(null);
        setLastSeenAt(null);
        setRetryAttempt(0);
        setStatus('unpaired');
    }, [replaceConnection]);

    const request = useCallback(
        async <M extends CaxriMethod>(
            method: M,
            ...arguments_: ParametersArgument<M>
        ): Promise<MethodResult<M>> => {
            const current = connection.current;
            if (!current) throw new Error('Caxri is reconnecting.');
            try {
                const result = await current.request(method, ...arguments_);
                setLastSeenAt(Date.now());
                return result;
            } catch (error) {
                if (
                    !(error instanceof MobileGatewayRequestError) &&
                    connection.current === current
                ) {
                    replaceConnection(null);
                    setStatus('stale');
                }
                throw error;
            }
        },
        [replaceConnection],
    );

    const value = useMemo<MobileClientContextValue>(
        () => ({
            forgetDevice,
            lastSeenAt,
            pair,
            paired: credential !== null,
            request,
            status,
        }),
        [credential, forgetDevice, lastSeenAt, pair, request, status],
    );

    return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The provider and its required context hook form one boundary.
export const useMobileClient = (): MobileClientContextValue => {
    const value = useContext(MobileClientContext);
    if (!value) throw new Error('MobileClientProvider is missing');
    return value;
};
