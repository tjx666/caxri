import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { router } from 'expo-router';

import { ActionButton } from '../../../components/action-button';
import { LoadingScreen } from '../../../components/loading-screen';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { pairingErrorMessage } from '../pairing-error';
import type { PairingRouteParameters } from '../pairing-link-route';
import { pairingLinkFromRouteParameters } from '../pairing-link-route';

interface PairingLinkScreenProperties {
    parameters: PairingRouteParameters;
}

const completePairing = async (
    pair: () => Promise<void>,
    isMounted: () => boolean,
    onError: (message: string) => void,
): Promise<void> => {
    try {
        await pair();
        if (isMounted()) router.replace('/sessions');
    } catch (pairingError) {
        if (isMounted()) onError(pairingErrorMessage(pairingError));
    }
};

export const PairingLinkScreen = ({ parameters }: PairingLinkScreenProperties) => {
    const theme = useMobileTheme();
    const client = useMobileClient();
    const { cancelPairing } = client;
    const attempted = useRef(false);
    const mounted = useRef(true);
    const [error, setError] = useState<string>();

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            cancelPairing();
        };
    }, [cancelPairing]);

    useEffect(() => {
        if (client.status === 'booting' || attempted.current) return;
        attempted.current = true;
        // eslint-disable-next-line no-void -- This screen owns the single bounded pairing attempt.
        void completePairing(
            () => client.pair(pairingLinkFromRouteParameters(parameters)),
            () => mounted.current,
            setError,
        );
    }, [client, parameters]);

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
