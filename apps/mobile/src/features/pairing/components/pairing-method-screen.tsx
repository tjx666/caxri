import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

import { ActionButton } from '../../../components/action-button';
import { IconButton } from '../../../components/icon-button';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { pairingErrorMessage } from '../pairing-error';

const PairingError = ({
    error,
    onScanAgain,
    theme,
}: {
    error: string;
    onScanAgain?: () => void;
    theme: MobileTheme;
}) => (
    <View style={styles.errorBlock}>
        <Text
            accessibilityRole="alert"
            style={[styles.error, { color: theme.danger }]}
            testID="pairing-error"
        >
            {error}
        </Text>
        {onScanAgain ? (
            <ActionButton
                accessibilityHint="Allows the camera to scan the pairing code again."
                onPress={onScanAgain}
                testID="pairing-scan-retry-button"
                theme={theme}
                variant="secondary"
            >
                Scan again
            </ActionButton>
        ) : null}
    </View>
);

/**
 * The camera renders only once access is granted; until then the screen asks for it and keeps paste reachable.
 */
const ScanControls = ({
    isBusy,
    onScan,
    permission,
    requestPermission,
    theme,
}: {
    isBusy: boolean;
    onScan: (source: string) => void;
    permission: ReturnType<typeof useCameraPermissions>[0];
    requestPermission: () => unknown;
    theme: MobileTheme;
}) => {
    if (!permission) return null;
    if (permission.granted)
        return (
            <View style={[styles.cameraFrame, { borderColor: theme.border }]}>
                <CameraView
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={isBusy ? undefined : ({ data }) => onScan(data)}
                    style={styles.camera}
                    testID="pairing-camera"
                />
            </View>
        );
    return (
        <>
            <ActionButton
                accessibilityHint="Requests camera access to scan a Caxri pairing code."
                onPress={requestPermission}
                testID="pairing-camera-permission-button"
                theme={theme}
            >
                Allow camera access
            </ActionButton>
            <Text style={[styles.fallback, { color: theme.muted }]}>
                Camera access is optional. You can go back and paste the pairing link instead.
            </Text>
        </>
    );
};

interface PairingMethodScreenProperties {
    method: 'paste' | 'scan';
}

export const PairingMethodScreen = ({ method }: PairingMethodScreenProperties) => {
    const theme = useMobileTheme();
    const client = useMobileClient();
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pairing = useRef(false);
    const lastScannedValue = useRef<string | null>(null);

    const pair = useCallback(
        async (source: string): Promise<void> => {
            if (pairing.current) return;
            pairing.current = true;
            setBusy(true);
            setError(null);
            try {
                await client.pair(source);
                router.replace('/sessions');
            } catch (pairingError) {
                setError(pairingErrorMessage(pairingError));
                pairing.current = false;
            } finally {
                setBusy(false);
            }
        },
        [client],
    );

    const paste = useCallback(async (): Promise<void> => {
        const source = await Clipboard.getStringAsync();
        if (!source) {
            setError('Your clipboard does not contain a Caxri pairing link.');
            return;
        }
        await pair(source);
    }, [pair]);

    const scan = useCallback(
        (source: string): void => {
            if (lastScannedValue.current === source) return;
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
                    <View style={styles.header}>
                        <IconButton
                            accessibilityHint="Returns to the pairing method choices."
                            accessibilityLabel="Back"
                            icon={ChevronLeft}
                            onPress={() => router.back()}
                            testID={`pairing-${method}-back-button`}
                            theme={theme}
                        />
                    </View>
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
                        {method === 'scan' ? (
                            <ScanControls
                                isBusy={busy}
                                onScan={scan}
                                permission={cameraPermission}
                                requestPermission={requestCameraPermission}
                                theme={theme}
                            />
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
                            <PairingError
                                error={error}
                                onScanAgain={
                                    method === 'scan'
                                        ? () => {
                                              lastScannedValue.current = null;
                                              setError(null);
                                          }
                                        : undefined
                                }
                                theme={theme}
                            />
                        ) : null}
                    </View>
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
        maxWidth: 520,
        padding: 24,
        paddingTop: 8,
        width: '100%',
    },
    header: {
        marginBottom: 12,
        marginLeft: -12,
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
