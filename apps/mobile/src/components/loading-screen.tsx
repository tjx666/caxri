/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileTheme } from '../theme/use-mobile-theme';
import { Spinner } from './spinner';

export const LoadingScreen = ({ label }: { label: string }) => {
    const theme = useMobileTheme();
    return (
        <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
            <View style={styles.content} testID="loading-screen">
                <Spinner color={theme.primary} />
                <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    content: {
        alignItems: 'center',
        flex: 1,
        gap: 12,
        justifyContent: 'center',
    },
    label: {
        fontSize: 15,
    },
    safeArea: {
        flex: 1,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
