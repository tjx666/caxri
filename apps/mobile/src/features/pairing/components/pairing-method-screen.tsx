import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

import { ActionButton } from '../../../components/action-button';
import { IconButton } from '../../../components/icon-button';
import { useTranslation } from '../../../i18n';
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
}) => {
    const { t } = useTranslation();
    return (
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
                    accessibilityHint={t('pairing.scanAgainHint')}
                    onPress={onScanAgain}
                    testID="pairing-scan-retry-button"
                    theme={theme}
                    variant="secondary"
                >
                    {t('pairing.scanAgain')}
                </ActionButton>
            ) : null}
        </View>
    );
};

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
    const { t } = useTranslation();
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
    /**
     * Once the OS has denied the request and will not prompt again, `requestPermission` resolves immediately without
     * showing anything, so the button silently does nothing. `Linking.openSettings` is the only remaining path back to
     * camera access.
     */
    if (!permission.canAskAgain)
        return (
            <>
                <ActionButton
                    accessibilityHint={t('pairing.openSettingsHint')}
                    onPress={() => {
                        // eslint-disable-next-line no-void -- Opening system Settings has no in-app result to await.
                        void Linking.openSettings();
                    }}
                    testID="pairing-camera-settings-button"
                    theme={theme}
                >
                    {t('pairing.openSettings')}
                </ActionButton>
                <Text style={[styles.fallback, { color: theme.muted }]}>
                    {t('pairing.cameraOptional')}
                </Text>
            </>
        );
    return (
        <>
            <ActionButton
                accessibilityHint={t('pairing.allowCameraHint')}
                onPress={requestPermission}
                testID="pairing-camera-permission-button"
                theme={theme}
            >
                {t('pairing.allowCamera')}
            </ActionButton>
            <Text style={[styles.fallback, { color: theme.muted }]}>
                {t('pairing.cameraOptional')}
            </Text>
        </>
    );
};

interface PairingMethodScreenProperties {
    method: 'paste' | 'scan';
}

export const PairingMethodScreen = ({ method }: PairingMethodScreenProperties) => {
    const theme = useMobileTheme();
    const { t } = useTranslation();
    const { cancelPairing, pair: pairWithClient } = useMobileClient();
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pairing = useRef(false);
    const mounted = useRef(true);
    const lastScannedValue = useRef<string | null>(null);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            cancelPairing();
        };
    }, [cancelPairing]);

    const pair = useCallback(
        async (source: string): Promise<void> => {
            if (pairing.current) return;
            pairing.current = true;
            setBusy(true);
            setError(null);
            try {
                await pairWithClient(source);
                if (mounted.current) router.replace('/sessions');
            } catch (pairingError) {
                if (mounted.current) setError(pairingErrorMessage(pairingError, t));
            } finally {
                if (mounted.current) {
                    pairing.current = false;
                    setBusy(false);
                }
            }
        },
        [pairWithClient, t],
    );

    const paste = useCallback(async (): Promise<void> => {
        const source = await Clipboard.getStringAsync();
        if (!source) {
            setError(t('pairing.clipboardEmpty'));
            return;
        }
        await pair(source);
    }, [pair, t]);

    const scan = useCallback(
        (source: string): void => {
            if (lastScannedValue.current === source) return;
            lastScannedValue.current = source;
            // eslint-disable-next-line no-void -- The scanner owns this single in-flight pairing attempt.
            void pair(source);
        },
        [pair],
    );

    /**
     * Reads the code from a saved screenshot, for pairing on the same phone or when the camera is unavailable. The
     * system photo picker needs no media permission.
     */
    const scanPhoto = useCallback(async (): Promise<void> => {
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
        const asset = result.canceled ? undefined : result.assets[0];
        if (!asset) return;
        let source: string | undefined;
        try {
            source = (await scanFromURLAsync(asset.uri, ['qr']))[0]?.data;
        } catch {
            // An image the decoder cannot read is reported the same way as one without a code.
        }
        if (!source) {
            setError(t('pairing.noCodeInImage'));
            return;
        }
        await pair(source);
    }, [pair, t]);

    const title = t(method === 'scan' ? 'pairing.scanCode' : 'pairing.pasteLink');
    const description = t(
        method === 'scan' ? 'pairing.scanDescription' : 'pairing.pasteDescription',
    );

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
                            accessibilityHint={t('pairing.backHint')}
                            accessibilityLabel={t('components.back')}
                            icon={ChevronLeft}
                            onPress={() => {
                                cancelPairing();
                                router.back();
                            }}
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
                        {method === 'scan' ? (
                            <ActionButton
                                accessibilityHint={t('pairing.choosePhotoHint')}
                                onPress={scanPhoto}
                                testID="pairing-scan-photo-button"
                                theme={theme}
                                variant="secondary"
                            >
                                {t('pairing.choosePhoto')}
                            </ActionButton>
                        ) : null}
                        {method === 'paste' ? (
                            <ActionButton
                                accessibilityHint={t('pairing.pasteAndPairHint')}
                                onPress={paste}
                                testID="pairing-paste-confirm-button"
                                theme={theme}
                            >
                                {t('pairing.pasteAndPair')}
                            </ActionButton>
                        ) : null}
                        {busy ? (
                            <View
                                accessible
                                accessibilityLabel={t('pairing.inProgressLabel')}
                                style={styles.progress}
                            >
                                <ActivityIndicator color={theme.primary} />
                                <Text style={[styles.progressText, { color: theme.muted }]}>
                                    {t('pairing.inProgress')}
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
