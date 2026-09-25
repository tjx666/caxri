import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useNewSession } from '../hooks/use-new-session';
import { NewSessionFooter } from './new-session-footer';
import { NewSessionSelections } from './new-session-selections';
import { NewSessionStatus } from './new-session-status';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const state = useNewSession();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="new-session-screen"
        >
            <View style={styles.header}>
                <Pressable
                    accessibilityLabel="Back to Sessions"
                    accessibilityRole="button"
                    onPress={() => router.back()}
                    style={styles.back}
                    testID="new-session-back"
                >
                    <Text style={[styles.backText, { color: theme.text }]}>×</Text>
                </Pressable>
                <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                    New Session
                </Text>
            </View>
            <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
                <NewSessionStatus state={state} theme={theme} />
                <NewSessionSelections state={state} theme={theme} />
            </ScrollView>
            <NewSessionFooter state={state} theme={theme} />
        </SafeAreaView>
    );
};
