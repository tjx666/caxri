import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { router, useFocusEffect } from 'expo-router';

import { ActionButton } from '../../../components/action-button';
import { LoadingScreen } from '../../../components/loading-screen';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { PairingRouteParameters } from '../pairing-link-route';
import { readPairingRoute, startPairingRoute } from '../pairing-link-route';

interface PairingLinkScreenProperties {
    parameters: PairingRouteParameters;
}

export const PairingLinkScreen = ({ parameters }: PairingLinkScreenProperties) => {
    const theme = useMobileTheme();
    const client = useMobileClient();
    const { cancelPairing, pair, isForeground } = client;
    const isReady = client.status !== 'booting';
    const { link, error: parameterError } = readPairingRoute(parameters);
    const [error, setError] = useState<string>();

    useFocusEffect(
        useCallback(() => {
            if (!isReady || !isForeground) return;
            setError(parameterError);
            if (!link) return;
            return startPairingRoute({
                link,
                pair,
                cancel: cancelPairing,
                onSuccess: () => router.replace('/sessions'),
                onError: setError,
            });
        }, [cancelPairing, isForeground, link, pair, parameterError, isReady]),
    );

    if (!error)
        return (
            <LoadingScreen
                label={
                    client.status === 'booting' ? 'Opening pairing link…' : 'Pairing with Caxri…'
                }
            />
        );

    return (
        <SafeAreaView
            style={[styles.safeArea, { backgroundColor: theme.background }]}
            testID="pairing-link-screen"
        >
            <View style={styles.content}>
                <View style={styles.copy}>
                    <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                        Pairing failed
                    </Text>
                    <Text
                        accessibilityRole="alert"
                        style={[styles.description, { color: theme.muted }]}
                        testID="pairing-error"
                    >
                        {error}
                    </Text>
                </View>
                <ActionButton
                    accessibilityHint="Returns to the pairing method choices."
                    onPress={() => router.replace('/')}
                    testID="pairing-link-back-button"
                    theme={theme}
                    variant="secondary"
                >
                    Choose another pairing method
                </ActionButton>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    content: {
        alignSelf: 'center',
        flex: 1,
        justifyContent: 'space-between',
        maxWidth: 520,
        padding: 24,
        width: '100%',
    },
    copy: {
        gap: 14,
        marginTop: 48,
    },
    description: {
        fontSize: 16,
        lineHeight: 24,
    },
    safeArea: {
        flex: 1,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        letterSpacing: -0.5,
        lineHeight: 28,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
