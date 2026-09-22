import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';

import { ActionButton } from '../../../components/action-button';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { isMobilePairingCancelledError } from '../../connection/mobile-gateway-client';
import type { PairingOperation } from '../../connection/pairing-attempt';
import { pairingErrorMessage } from '../pairing-error';

interface PairingMethodScreenProperties {
    method: 'paste' | 'scan';
}

export const PairingMethodScreen = ({ method }: PairingMethodScreenProperties) => {
    const theme = useMobileTheme();
    const { pair: startPairing } = useMobileClient();
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pairing = useRef(false);
    const lifecycle = useRef<{ active: boolean }>({ active: false });
    const activePairing = useRef<PairingOperation | null>(null);
    const pendingClipboard = useRef<AbortController | null>(null);
    const lastScannedValue = useRef<string | null>(null);
    const isLifecycleActive = useCallback(() => lifecycle.current.active, []);

    const cancelPairing = useCallback((): void => {
        pendingClipboard.current?.abort();
        pendingClipboard.current = null;
        activePairing.current?.cancel();
        activePairing.current = null;
        pairing.current = false;
        lastScannedValue.current = null;
        if (isLifecycleActive()) setBusy(false);
    }, [isLifecycleActive]);

    useFocusEffect(
        useCallback(() => {
            lifecycle.current.active = true;
            setBusy(false);
            return () => {
                lifecycle.current.active = false;
                cancelPairing();
            };
        }, [cancelPairing]),
    );

    const pair = useCallback(
        async (source: string): Promise<void> => {
            if (pairing.current || pendingClipboard.current || !isLifecycleActive()) return;
            pairing.current = true;
            setBusy(true);
            setError(null);
            const operation = startPairing(source);
            activePairing.current = operation;
            try {
                await operation.promise;
                if (isLifecycleActive() && activePairing.current === operation)
                    router.replace('/sessions');
            } catch (pairingError) {
                if (
                    isLifecycleActive() &&
                    activePairing.current === operation &&
                    !isMobilePairingCancelledError(pairingError)
                )
                    setError(pairingErrorMessage(pairingError));
            } finally {
                if (activePairing.current === operation) {
                    activePairing.current = null;
                    pairing.current = false;
                    if (isLifecycleActive()) setBusy(false);
                }
            }
        },
        [isLifecycleActive, startPairing],
    );

    const paste = useCallback(async (): Promise<void> => {
        if (pairing.current || pendingClipboard.current || !isLifecycleActive()) return;
        const controller = new AbortController();
        pendingClipboard.current = controller;
        setBusy(true);
        setError(null);
        try {
            const source = await Clipboard.getStringAsync();
            if (controller.signal.aborted || !isLifecycleActive()) return;
            if (!source) {
                setError('Your clipboard does not contain a Caxri pairing link.');
                return;
            }
            pendingClipboard.current = null;
            await pair(source);
        } finally {
            if (pendingClipboard.current === controller) {
                pendingClipboard.current = null;
                if (isLifecycleActive() && !activePairing.current) setBusy(false);
            }
        }
    }, [isLifecycleActive, pair]);

    const scan = useCallback(
        (source: string): void => {
            if (lastScannedValue.current === source || pairing.current || pendingClipboard.current)
                return;
            lastScannedValue.current = source;
            // eslint-disable-next-line no-void -- The scanner owns this single in-flight pairing attempt.
            void pair(source);
        },
        [pair],
    );

    const title = method === 'scan' ? 'Scan pairing code' : 'Paste pairing link';
    const description =
        method === 'scan'
            ? 'Point the camera at the code shown in Caxri Settings.'
            : 'Use the short-lived link copied from Caxri Settings.';

    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
            testID={`pairing-${method}-screen`}
        >
            <ScrollView contentContainerStyle={styles.scroll}>
                <View style={styles.frame}>
                    <View style={styles.copy}>
                        <Text
                            accessibilityRole="header"
                            style={[styles.title, { color: theme.text }]}
                        >
                            {title}
                        </Text>
                        <Text style={[styles.description, { color: theme.muted }]}>
                            {description}
                        </Text>
                        {method === 'scan' && cameraPermission?.granted ? (
                            <View style={[styles.cameraFrame, { borderColor: theme.border }]}>
                                <CameraView
                                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                                    onBarcodeScanned={busy ? undefined : ({ data }) => scan(data)}
                                    style={styles.camera}
                                    testID="pairing-camera"
                                />
                            </View>
                        ) : null}
                        {method === 'scan' && cameraPermission && !cameraPermission.granted ? (
                            <ActionButton
                                accessibilityHint="Requests camera access to scan a Caxri pairing code."
                                onPress={requestCameraPermission}
                                testID="pairing-camera-permission-button"
                                theme={theme}
                            >
                                Allow camera access
                            </ActionButton>
                        ) : null}
                        {method === 'paste' ? (
                            <ActionButton
                                accessibilityHint="Reads and uses the Caxri pairing link from the clipboard."
                                onPress={paste}
                                testID="pairing-paste-confirm-button"
                                theme={theme}
                            >
                                Paste and pair
                            </ActionButton>
                        ) : null}
                        {busy ? (
                            <View
                                accessible
                                accessibilityLabel="Pairing with Caxri"
                                style={styles.progress}
                            >
                                <ActivityIndicator color={theme.primary} />
                                <Text style={[styles.progressText, { color: theme.muted }]}>
                                    Pairing…
                                </Text>
                            </View>
                        ) : null}
                        {error ? (
                            <View style={styles.errorBlock}>
                                <Text
                                    accessibilityRole="alert"
                                    style={[styles.error, { color: theme.danger }]}
                                    testID="pairing-error"
                                >
                                    {error}
                                </Text>
                                {method === 'scan' ? (
                                    <ActionButton
                                        accessibilityHint="Allows the camera to scan the pairing code again."
                                        onPress={() => {
                                            lastScannedValue.current = null;
                                            setError(null);
                                        }}
                                        testID="pairing-scan-retry-button"
                                        theme={theme}
                                        variant="secondary"
                                    >
                                        Scan again
                                    </ActionButton>
                                ) : null}
                            </View>
                        ) : null}
                        {method === 'scan' && cameraPermission && !cameraPermission.granted ? (
                            <Text style={[styles.fallback, { color: theme.muted }]}>
                                Camera access is optional. You can go back and paste the pairing
                                link instead.
                            </Text>
                        ) : null}
                    </View>
                    <ActionButton
                        accessibilityHint="Returns to the pairing method choices."
                        onPress={() => {
                            cancelPairing();
                            router.back();
                        }}
                        testID={`pairing-${method}-back-button`}
                        theme={theme}
                        variant="secondary"
                    >
                        Back
                    </ActionButton>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    copy: {
        gap: 14,
    },
    camera: {
        flex: 1,
    },
    cameraFrame: {
        aspectRatio: 1,
        borderRadius: 18,
        borderWidth: 1,
        marginTop: 8,
        overflow: 'hidden',
    },
    description: {
        fontSize: 16,
        lineHeight: 24,
    },
    error: {
        fontSize: 14,
        lineHeight: 20,
    },
    errorBlock: {
        gap: 10,
    },
    fallback: {
        fontSize: 13,
        lineHeight: 19,
    },
    frame: {
        alignSelf: 'center',
        flex: 1,
        justifyContent: 'space-between',
        maxWidth: 520,
        padding: 24,
        width: '100%',
    },
    safeArea: {
        flex: 1,
    },
    scroll: {
        flexGrow: 1,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        letterSpacing: -0.5,
        lineHeight: 28,
    },
    progress: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 10,
        justifyContent: 'center',
    },
    progressText: {
        fontSize: 14,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
