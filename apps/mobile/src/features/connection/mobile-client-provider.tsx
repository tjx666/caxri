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
import { AppState } from 'react-native';

import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import * as Device from 'expo-device';
import * as Network from 'expo-network';

import type { MobileConnectionStatus } from './connection-state';
import type { MobileCredential } from './credential-store';
import { expoMobileCredentialStore } from './expo-credential-store';
import { expoMobileGatewayRuntime } from './expo-mobile-gateway-runtime';
import type { MobileGatewayConnection } from './mobile-gateway-client';
import {
    MobileGatewayRequestError,
    MobileReconnectError,
    MobileVersionMismatchError,
    pairMobileGateway,
    reconnectMobileGateway,
} from './mobile-gateway-client';
import { watchMobileNetwork } from './network-recovery';
import {
    foregroundRecoveryAction,
    observeMobileConnectionTermination,
} from './reconnect-lifecycle';
import { useMobileReconnect } from './use-mobile-reconnect';

interface MobileClientContextValue {
    forgetDevice: () => Promise<void>;
    hostId: string | null;
    isForeground: boolean;
    lastSeenAt: number | null;
    pair: (pairingLink: string) => Promise<void>;
    paired: boolean;
    request: <M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => Promise<MethodResult<M>>;
    retryConnection: () => void;
    status: MobileConnectionStatus;
}

const MobileClientContext = createContext<MobileClientContextValue | null>(null);

export const MobileClientProvider = ({ children }: { children: ReactNode }) => {
    const [credential, setCredential] = useState<MobileCredential | null>(null);
    const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
    const [retryAttempt, setRetryAttempt] = useState(0);
    const [retryToken, setRetryToken] = useState(0);
    const [status, setStatus] = useState<MobileConnectionStatus>('booting');
    const [isForeground, setIsForeground] = useState(AppState.currentState === 'active');
    const connection = useRef<MobileGatewayConnection | null>(null);
    const backgroundedAt = useRef<number | null>(null);
    const appState = useRef(AppState.currentState);
    const activeProbe = useRef<MobileGatewayConnection | null>(null);
    const deferredNetworkWake = useRef(false);
    const removeTerminationListener = useRef<() => void>(() => {});

    const replaceConnection = useCallback((next: MobileGatewayConnection | null): void => {
        removeTerminationListener.current();
        removeTerminationListener.current = () => {};
        if (connection.current !== next) {
            connection.current?.close();
            activeProbe.current = null;
            deferredNetworkWake.current = false;
        }
        connection.current = next;
    }, []);

    const probeCurrentConnection = useCallback(
        (current: MobileGatewayConnection): void => {
            if (activeProbe.current === current) return;
            if (current.hasOutstandingMutation()) {
                deferredNetworkWake.current = true;
                return;
            }
            activeProbe.current = current;
            // eslint-disable-next-line no-void -- A single bounded probe belongs to the current connection.
            void current
                .probe()
                .then(() => {
                    if (connection.current === current) setLastSeenAt(Date.now());
                })
                .catch(() => {
                    if (connection.current !== current) return;
                    replaceConnection(null);
                    setLastSeenAt(null);
                    setRetryAttempt(0);
                    setStatus('stale');
                })
                .finally(() => {
                    if (activeProbe.current === current) activeProbe.current = null;
                });
        },
        [replaceConnection],
    );

    const adoptConnection = useCallback(
        (next: MobileGatewayConnection): boolean => {
            replaceConnection(next);
            const observation = observeMobileConnectionTermination(next, (reason) => {
                if (connection.current !== next) return;
                replaceConnection(null);
                setLastSeenAt(null);
                setRetryAttempt(0);
                if (reason === 'revoked') {
                    setCredential(null);
                    setStatus('revoked');
                } else setStatus('stale');
            });
            removeTerminationListener.current = observation.unsubscribe;
            return !observation.didTerminate;
        },
        [replaceConnection],
    );

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
            reconnectMobileGateway(
                storedCredential,
                expoMobileGatewayRuntime,
                expoMobileCredentialStore,
            ),
        [],
    );
    const acceptReconnection = useCallback(
        (next: MobileGatewayConnection): void => {
            if (!adoptConnection(next)) return;
            setLastSeenAt(Date.now());
            setRetryAttempt(0);
            setStatus('connected');
        },
        [adoptConnection],
    );
    const rejectReconnection = useCallback((error: unknown): void => {
        if (error instanceof MobileVersionMismatchError) {
            setRetryAttempt(0);
            setStatus('version-mismatch');
            return;
        }
        if (error instanceof MobileReconnectError) {
            setRetryAttempt(0);
            setStatus('unverified');
            return;
        }
        setRetryAttempt((attempt) => attempt + 1);
        setStatus('stale');
    }, []);
    useMobileReconnect({
        connect: reconnect,
        credential,
        isForeground,
        onConnected: acceptReconnection,
        onFailed: rejectReconnection,
        retryToken,
        retryAttempt,
        status,
    });

    useEffect(() => {
        const listener = AppState.addEventListener('change', (nextState) => {
            const wasForeground = appState.current === 'active';
            appState.current = nextState;
            if (nextState !== 'active') {
                if (wasForeground) backgroundedAt.current = Date.now();
                setIsForeground(false);
                return;
            }
            if (wasForeground) return;
            setIsForeground(true);
            if (!credential || status === 'version-mismatch' || status === 'unverified') return;
            const current = connection.current;
            if (current?.hasOutstandingMutation()) {
                deferredNetworkWake.current = true;
                return;
            }
            const action = foregroundRecoveryAction({
                backgroundedAt: backgroundedAt.current,
                hasConnection: current !== null,
                now: Date.now(),
            });
            backgroundedAt.current = null;
            if (action === 'reconnect') {
                replaceConnection(null);
                setLastSeenAt(null);
                setRetryAttempt(0);
                setRetryToken((token) => token + 1);
                setStatus('stale');
                return;
            }
            if (current) probeCurrentConnection(current);
        });
        return () => listener.remove();
    }, [credential, probeCurrentConnection, replaceConnection, status]);

    useEffect(
        () =>
            watchMobileNetwork({
                subscribe: (listener) => Network.addNetworkStateListener(listener),
                context: () => ({
                    hasOutstandingMutation: connection.current?.hasOutstandingMutation() ?? false,
                    isForeground,
                    status,
                }),
                onAction: (action) => {
                    if (action === 'defer') {
                        deferredNetworkWake.current = true;
                        return;
                    }
                    if (action === 'reconnect') {
                        if (!credential) return;
                        replaceConnection(null);
                        setLastSeenAt(null);
                        setRetryAttempt(0);
                        setRetryToken((token) => token + 1);
                        setStatus('stale');
                        return;
                    }
                    const current = connection.current;
                    if (current) probeCurrentConnection(current);
                },
            }),
        [credential, isForeground, probeCurrentConnection, replaceConnection, status],
    );

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
                if (!adoptConnection(paired.connection)) return;
                setLastSeenAt(Date.now());
                setRetryAttempt(0);
                setStatus('connected');
            } catch (error) {
                setStatus(
                    error instanceof MobileVersionMismatchError
                        ? 'version-mismatch'
                        : credential
                          ? 'stale'
                          : 'unpaired',
                );
                throw error;
            }
        },
        [adoptConnection, credential, replaceConnection],
    );

    const forgetDevice = useCallback(async (): Promise<void> => {
        replaceConnection(null);
        await expoMobileCredentialStore.clear();
        setCredential(null);
        setLastSeenAt(null);
        setRetryAttempt(0);
        setStatus('unpaired');
    }, [replaceConnection]);

    const retryConnection = useCallback((): void => {
        if (!credential || status === 'version-mismatch') return;
        setRetryAttempt(0);
        setStatus('stale');
    }, [credential, status]);

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
            } finally {
                if (
                    isForeground &&
                    deferredNetworkWake.current &&
                    connection.current === current &&
                    !current.hasOutstandingMutation()
                ) {
                    deferredNetworkWake.current = false;
                    probeCurrentConnection(current);
                }
            }
        },
        [isForeground, probeCurrentConnection, replaceConnection],
    );

    const value = useMemo<MobileClientContextValue>(
        () => ({
            forgetDevice,
            hostId: credential?.serverId ?? null,
            isForeground,
            lastSeenAt,
            pair,
            paired: credential !== null,
            request,
            retryConnection,
            status,
        }),
        [
            credential,
            forgetDevice,
            isForeground,
            lastSeenAt,
            pair,
            request,
            retryConnection,
            status,
        ],
    );

    return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The provider and its required context hook form one boundary.
export const useMobileClient = (): MobileClientContextValue => {
    const value = useContext(MobileClientContext);
    if (!value) throw new Error('MobileClientProvider is missing');
    return value;
};
