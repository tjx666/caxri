import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { AppStateStatus } from 'react-native';
import { AppState } from 'react-native';

import type { MobileSubscriptionResource } from '@caxri/mobile-transport';
import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import * as Device from 'expo-device';
import * as Network from 'expo-network';

import type { MobileConnectionStatus } from './connection-state';
import { loadMobileCredential } from './credential-load';
import type { MobileCredential } from './credential-store';
import { expoMobileCredentialStore } from './expo-credential-store';
import { expoMobileGatewayRuntime } from './expo-mobile-gateway-runtime';
import type { MobileSubscriptionListener } from './mobile-frame-router';
import type {
    MobileGatewayConnection,
    MobileGatewaySubscriptionHandle,
} from './mobile-gateway-client';
import {
    MobileGatewayRequestError,
    MobileGatewayTimeoutError,
    MobileReconnectError,
    MobileVersionMismatchError,
    pairMobileGateway,
    reconnectMobileGateway,
} from './mobile-gateway-client';
import type { MobileNetworkWakeAction } from './network-recovery';
import { watchMobileNetwork } from './network-recovery';
import { createPairingAttemptOwner } from './pairing-attempt';
import {
    foregroundRecoveryAction,
    observeMobileConnectionTermination,
} from './reconnect-lifecycle';
import { useMobileReconnect } from './use-mobile-reconnect';

export interface MobileClientContextValue {
    cancelPairing: () => void;
    connectionEpoch: number;
    connectionScopeKey: string | null;
    forgetDevice: () => Promise<void>;
    hostId: string | null;
    isForeground: boolean;
    getLastSeenAt: () => number | null;
    pair: (pairingLink: string) => Promise<void>;
    paired: boolean;
    request: <M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => Promise<MethodResult<M>>;
    retryConnection: () => void;
    retryCredentialLoad: () => void;
    status: MobileConnectionStatus;
    subscribe: (
        resource: MobileSubscriptionResource,
        listener: MobileSubscriptionListener,
    ) => Promise<MobileGatewaySubscriptionHandle>;
    subscriptionAvailable: boolean;
}

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

export const useMobileClientController = (): MobileClientContextValue => {
    const [credential, setCredential] = useState<MobileCredential | null>(null);
    const [connectionEpoch, setConnectionEpoch] = useState(0);
    // Authenticated output can arrive every frame; only the freshness clock samples this value.
    const lastSeenAt = useRef<number | null>(null);
    const getLastSeenAt = useCallback(() => lastSeenAt.current, []);
    const setLastSeenAt = useCallback((value: number | null): void => {
        lastSeenAt.current = value;
    }, []);
    const [retryAttempt, setRetryAttempt] = useState(0);
    const [retryToken, setRetryToken] = useState(0);
    const [credentialLoadAttempt, setCredentialLoadAttempt] = useState(0);
    const [status, setStatus] = useState<MobileConnectionStatus>('booting');
    const [isForeground, setIsForeground] = useState(AppState.currentState === 'active');
    const connection = useRef<MobileGatewayConnection | null>(null);
    const [pairingAttempts] = useState(createPairingAttemptOwner);
    const backgroundedAt = useRef<number | null>(null);
    const appState = useRef(AppState.currentState);
    const activeProbe = useRef<MobileGatewayConnection | null>(null);
    const deferredForegroundReconnect = useRef(false);
    const deferredNetworkWake = useRef(false);
    const removeTerminationListener = useRef<() => void>(() => {});
    const removeObservationListener = useRef<() => void>(() => {});

    const replaceConnection = useCallback((next: MobileGatewayConnection | null): void => {
        removeTerminationListener.current();
        removeTerminationListener.current = () => {};
        removeObservationListener.current();
        removeObservationListener.current = () => {};
        if (connection.current !== next) {
            connection.current?.close();
            activeProbe.current = null;
            deferredForegroundReconnect.current = false;
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
                    if (current.hasOutstandingMutation()) {
                        deferredNetworkWake.current = true;
                        return;
                    }
                    replaceConnection(null);
                    setLastSeenAt(null);
                    setRetryAttempt(0);
                    setStatus('stale');
                })
                .finally(() => {
                    if (activeProbe.current === current) activeProbe.current = null;
                });
        },
        [replaceConnection, setLastSeenAt],
    );

    const adoptConnection = useCallback(
        (next: MobileGatewayConnection): boolean => {
            replaceConnection(next);
            next.setForeground(appState.current === 'active');
            removeObservationListener.current = next.onObservation(() => {
                if (connection.current === next) setLastSeenAt(Date.now());
            });
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
            if (!observation.didTerminate) setConnectionEpoch((epoch) => epoch + 1);
            return !observation.didTerminate;
        },
        [replaceConnection, setLastSeenAt],
    );

    useEffect(() => {
        let isActive = true;
        const loadCredential = async (): Promise<void> => {
            const result = await loadMobileCredential(expoMobileCredentialStore);
            if (!isActive) return;
            if (result.kind === 'storage-error') {
                setStatus('storage-error');
                return;
            }
            setCredential(result.credential);
            setStatus(result.credential ? 'stale' : 'unpaired');
        };
        // eslint-disable-next-line no-void -- React effects cannot return the credential-loading promise.
        void loadCredential();
        return () => {
            isActive = false;
            pairingAttempts.invalidate();
            replaceConnection(null);
        };
    }, [credentialLoadAttempt, pairingAttempts, replaceConnection]);

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
        [adoptConnection, setLastSeenAt],
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

    const onAppStateChange = useEffectEvent((nextState: AppStateStatus) => {
        const wasForeground = appState.current === 'active';
        appState.current = nextState;
        if (nextState !== 'active') {
            if (nextState === 'background' && pairingAttempts.cancel())
                setStatus(credential ? 'stale' : 'unpaired');
            if (wasForeground) backgroundedAt.current = Date.now();
            setIsForeground(false);
            return;
        }
        if (wasForeground) return;
        setIsForeground(true);
        if (!credential || status === 'version-mismatch' || status === 'unverified') return;
        const current = connection.current;
        const action = foregroundRecoveryAction({
            backgroundedAt: backgroundedAt.current,
            hasConnection: current !== null,
            now: Date.now(),
        });
        backgroundedAt.current = null;
        if (current?.hasOutstandingMutation()) {
            if (action === 'reconnect') deferredForegroundReconnect.current = true;
            else deferredNetworkWake.current = true;
            return;
        }
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
    useEffect(() => {
        const listener = AppState.addEventListener('change', onAppStateChange);
        return () => listener.remove();
    }, []);

    useEffect(() => {
        connection.current?.setForeground(isForeground);
    }, [isForeground]);

    const currentNetworkContext = useEffectEvent(() => ({
        hasOutstandingMutation: connection.current?.hasOutstandingMutation() ?? false,
        isForeground,
        status,
    }));
    const onNetworkAction = useEffectEvent((action: Exclude<MobileNetworkWakeAction, 'ignore'>) => {
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
    });
    useEffect(
        () =>
            watchMobileNetwork({
                subscribe: (listener) => Network.addNetworkStateListener(listener),
                context: () => currentNetworkContext(),
                onAction: (action) => onNetworkAction(action),
            }),
        [],
    );

    const pair = useCallback(
        async (pairingLink: string): Promise<void> => {
            if (appState.current !== 'active')
                throw new Error('Pairing is unavailable while Caxri is in the background.');
            const attempt = pairingAttempts.begin();
            const isCurrent = () => attempt.isCurrent() && appState.current === 'active';
            replaceConnection(null);
            setStatus('connecting');
            try {
                const paired = await pairMobileGateway({
                    isCurrent,
                    signal: attempt.signal,
                    displayName: Device.modelName ?? 'Mobile device',
                    pairingLink,
                    runtime: expoMobileGatewayRuntime,
                    store: expoMobileCredentialStore,
                });
                if (!isCurrent()) {
                    paired.connection.close();
                    throw new Error('Pairing attempt was superseded.');
                }
                setCredential(paired.credential);
                if (!adoptConnection(paired.connection)) return;
                setLastSeenAt(Date.now());
                setRetryAttempt(0);
                setStatus('connected');
            } catch (error) {
                if (!isCurrent()) throw error;
                setStatus(
                    error instanceof MobileVersionMismatchError
                        ? 'version-mismatch'
                        : credential
                          ? 'stale'
                          : 'unpaired',
                );
                throw error;
            } finally {
                attempt.finish();
            }
        },
        [adoptConnection, credential, pairingAttempts, replaceConnection, setLastSeenAt],
    );

    const cancelPairing = useCallback((): void => {
        if (!pairingAttempts.cancel()) return;
        setStatus(credential ? 'stale' : 'unpaired');
    }, [credential, pairingAttempts]);

    const forgetDevice = useCallback(async (): Promise<void> => {
        pairingAttempts.invalidate();
        replaceConnection(null);
        await expoMobileCredentialStore.clear();
        setCredential(null);
        setLastSeenAt(null);
        setRetryAttempt(0);
        setStatus('unpaired');
    }, [pairingAttempts, replaceConnection, setLastSeenAt]);

    const retryConnection = useCallback((): void => {
        if (!credential || status === 'version-mismatch') return;
        setRetryAttempt(0);
        setStatus('stale');
    }, [credential, status]);
    const retryCredentialLoad = useCallback((): void => {
        if (status !== 'storage-error') return;
        setStatus('booting');
        setCredentialLoadAttempt((attempt) => attempt + 1);
    }, [status]);

    const subscribe = useCallback(
        async (
            resource: MobileSubscriptionResource,
            listener: MobileSubscriptionListener,
        ): Promise<MobileGatewaySubscriptionHandle> => {
            const current = connection.current;
            if (!current || status !== 'connected' || !isForeground)
                throw new Error('Caxri is reconnecting.');
            return acquireMobileSubscription({
                connection: current,
                currentConnection: () => connection.current,
                listener,
                resource,
            });
        },
        [isForeground, status],
    );

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
                    error instanceof MobileGatewayTimeoutError &&
                    current.hasOutstandingMutation()
                ) {
                    deferredNetworkWake.current = true;
                } else if (
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
                    connection.current === current &&
                    !current.hasOutstandingMutation()
                ) {
                    if (deferredForegroundReconnect.current) {
                        deferredForegroundReconnect.current = false;
                        replaceConnection(null);
                        setLastSeenAt(null);
                        setRetryAttempt(0);
                        setRetryToken((token) => token + 1);
                        setStatus('stale');
                    } else if (deferredNetworkWake.current) {
                        deferredNetworkWake.current = false;
                        probeCurrentConnection(current);
                    }
                }
            }
        },
        [isForeground, probeCurrentConnection, replaceConnection, setLastSeenAt],
    );

    const value = useMemo<MobileClientContextValue>(
        () => ({
            cancelPairing,
            connectionEpoch,
            connectionScopeKey: credential
                ? JSON.stringify([credential.serverId, credential.deviceId, credential.generation])
                : null,
            forgetDevice,
            hostId: credential?.serverId ?? null,
            isForeground,
            getLastSeenAt,
            pair,
            paired: credential !== null,
            request,
            retryConnection,
            retryCredentialLoad,
            status,
            subscribe,
            subscriptionAvailable: status === 'connected' && isForeground,
        }),
        [
            cancelPairing,
            connectionEpoch,
            credential,
            forgetDevice,
            isForeground,
            getLastSeenAt,
            pair,
            request,
            retryConnection,
            retryCredentialLoad,
            status,
            subscribe,
        ],
    );

    return value;
};
