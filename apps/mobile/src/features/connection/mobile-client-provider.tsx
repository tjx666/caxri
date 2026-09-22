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
import type { MobileGatewayConnection, PairedMobileConnection } from './mobile-gateway-client';
import {
    isMobilePairingCancelledError,
    MobileGatewayRequestError,
    MobilePairingCancelledError,
    MobileReconnectError,
    pairMobileGateway,
    reconnectMobileGateway,
} from './mobile-gateway-client';
import type { PairingOperation } from './pairing-attempt';
import { createPairingAttemptRegistry, runPairingAttempt } from './pairing-attempt';
import { observeMobileConnectionTermination } from './reconnect-lifecycle';
import { useMobileReconnect } from './use-mobile-reconnect';

interface MobileClientContextValue {
    forgetDevice: () => Promise<void>;
    lastSeenAt: number | null;
    pair: (pairingLink: string) => PairingOperation;
    paired: boolean;
    request: <M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => Promise<MethodResult<M>>;
    retryConnection: () => void;
    status: MobileConnectionStatus;
}

const MobileClientContext = createContext<MobileClientContextValue | null>(null);

const settlePairingCompletion = async (operation: Promise<void>): Promise<void> => {
    try {
        await operation;
    } catch {
        // The owning screen receives the original operation error.
    }
};

export const MobileClientProvider = ({ children }: { children: ReactNode }) => {
    const [credential, setCredential] = useState<MobileCredential | null>(null);
    const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
    const [retryAttempt, setRetryAttempt] = useState(0);
    const [status, setStatus] = useState<MobileConnectionStatus>('booting');
    const connection = useRef<MobileGatewayConnection | null>(null);
    const removeTerminationListener = useRef<() => void>(() => {});
    const pairingAttempts = useRef(createPairingAttemptRegistry());
    const pairingCompletion = useRef(Promise.resolve());

    const replaceConnection = useCallback((next: MobileGatewayConnection | null): void => {
        removeTerminationListener.current();
        removeTerminationListener.current = () => {};
        if (connection.current !== next) connection.current?.close();
        connection.current = next;
    }, []);

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
        const attemptRegistry = pairingAttempts.current;
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
            attemptRegistry.cancelCurrent();
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
        onConnected: acceptReconnection,
        onFailed: rejectReconnection,
        retryAttempt,
        status,
    });

    const pair = useCallback(
        (pairingLink: string): PairingOperation => {
            const attempt = pairingAttempts.current.begin();
            replaceConnection(null);
            setStatus('connecting');
            const previousCompletion = pairingCompletion.current;
            const promise = (async (): Promise<void> => {
                try {
                    await previousCompletion;
                    if (!pairingAttempts.current.isCurrent(attempt))
                        throw new MobilePairingCancelledError();
                    await runPairingAttempt<PairedMobileConnection>({
                        adopt: (paired) => adoptConnection(paired.connection),
                        attempt,
                        cancellationError: () => new MobilePairingCancelledError(),
                        isCurrent: () => pairingAttempts.current.isCurrent(attempt),
                        onComplete: () => {
                            setLastSeenAt(Date.now());
                            setRetryAttempt(0);
                            setStatus('connected');
                            pairingAttempts.current.finish(attempt);
                        },
                        onPaired: (paired) => setCredential(paired.credential),
                        pair: (signal) =>
                            pairMobileGateway({
                                displayName: Device.modelName ?? 'Mobile device',
                                pairingLink,
                                runtime: expoMobileGatewayRuntime,
                                signal,
                                store: expoMobileCredentialStore,
                            }),
                        rollback: (paired) => paired.rollback(),
                    });
                } catch (error) {
                    if (
                        pairingAttempts.current.isCurrent(attempt) &&
                        !isMobilePairingCancelledError(error)
                    )
                        setStatus(credential ? 'stale' : 'unpaired');
                    throw error;
                } finally {
                    pairingAttempts.current.finish(attempt);
                }
            })();
            pairingCompletion.current = settlePairingCompletion(promise);
            return {
                cancel: () => {
                    const isCurrent = pairingAttempts.current.isCurrent(attempt);
                    pairingAttempts.current.cancel(attempt);
                    if (isCurrent) setStatus(credential ? 'stale' : 'unpaired');
                },
                promise,
            };
        },
        [adoptConnection, credential, replaceConnection],
    );

    const forgetDevice = useCallback(async (): Promise<void> => {
        const previousCompletion = pairingCompletion.current;
        pairingAttempts.current.cancelCurrent();
        replaceConnection(null);
        const clearing = (async (): Promise<void> => {
            await previousCompletion;
            await expoMobileCredentialStore.clear();
        })();
        const clearingCompletion = settlePairingCompletion(clearing);
        pairingCompletion.current = clearingCompletion;
        await clearing;
        if (pairingCompletion.current !== clearingCompletion) return;
        setCredential(null);
        setLastSeenAt(null);
        setRetryAttempt(0);
        setStatus('unpaired');
    }, [replaceConnection]);

    const retryConnection = useCallback((): void => {
        if (!credential) return;
        setRetryAttempt(0);
        setStatus('stale');
    }, [credential]);

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
            retryConnection,
            status,
        }),
        [credential, forgetDevice, lastSeenAt, pair, request, retryConnection, status],
    );

    return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The provider and its required context hook form one boundary.
export const useMobileClient = (): MobileClientContextValue => {
    const value = useContext(MobileClientContext);
    if (!value) throw new Error('MobileClientProvider is missing');
    return value;
};
