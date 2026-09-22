import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { router, useFocusEffect, useIsFocused } from 'expo-router';

import { ActionButton } from '../../../components/action-button';
import { LoadingScreen } from '../../../components/loading-screen';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { PairingOperation } from '../../connection/pairing-attempt';
import type { PairingRouteParameters } from '../pairing-link-route';
import { completePairing, readPairingLink } from '../pairing-screen-lifecycle';

interface PairingLinkScreenProperties {
    parameters: PairingRouteParameters;
}

export const PairingLinkScreen = ({ parameters }: PairingLinkScreenProperties) => {
    const theme = useMobileTheme();
    const { pair: startPairing, status } = useMobileClient();
    const focused = useIsFocused();
    const lifecycle = useRef<{ active: boolean }>({ active: false });
    const attemptedLink = useRef<string | undefined>(undefined);
    const activePairing = useRef<PairingOperation | null>(null);
    const [error, setError] = useState<string>();
    const isLifecycleActive = useCallback(() => lifecycle.current.active, []);

    const cancelPairing = useCallback((): void => {
        activePairing.current?.cancel();
        activePairing.current = null;
    }, []);

    useFocusEffect(
        useCallback(() => {
            lifecycle.current.active = true;
            return () => {
                lifecycle.current.active = false;
                cancelPairing();
                attemptedLink.current = undefined;
            };
        }, [cancelPairing]),
    );

    useEffect(() => {
        if (!focused || status === 'booting') return;
        const pairingLink = readPairingLink(parameters, setError);
        if (pairingLink === null) {
            cancelPairing();
            attemptedLink.current = undefined;
            return;
        }
        if (attemptedLink.current === pairingLink) return;
        attemptedLink.current = pairingLink;
        setError(undefined);
        const operation = startPairing(pairingLink);
        activePairing.current = operation;
        // eslint-disable-next-line no-void -- This screen owns the single bounded pairing attempt.
        void completePairing(
            () => operation.promise,
            () => isLifecycleActive() && activePairing.current === operation,
            () => router.replace('/sessions'),
            setError,
        ).finally(() => {
            if (activePairing.current === operation) activePairing.current = null;
        });
    }, [cancelPairing, focused, isLifecycleActive, parameters, startPairing, status]);

    if (!error)
        return (
            <LoadingScreen
                label={status === 'booting' ? 'Opening pairing link…' : 'Pairing with Caxri…'}
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
                    onPress={() => {
                        cancelPairing();
                        router.replace('/');
                    }}
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
