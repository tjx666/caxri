import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { useMobileTheme } from '../../../src/theme/use-mobile-theme';

const styles = StyleSheet.create({
    root: { flex: 1, padding: 16 },
    back: { justifyContent: 'center', minHeight: 48 },
    backText: { fontSize: 16 },
    title: { fontSize: 22, fontWeight: '700', marginTop: 16 },
    content: { flex: 1, gap: 12, justifyContent: 'center' },
    label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
    body: { fontSize: 15, lineHeight: 22 },
});

export default function NewSessionRoute() {
    const router = useRouter();
    const theme = useMobileTheme();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="new-session-screen"
        >
            <Pressable
                accessibilityLabel="Back to Sessions"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.back}
                testID="new-session-back"
            >
                <Text style={[styles.backText, { color: theme.text }]}>← Sessions</Text>
            </Pressable>
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                New Session
            </Text>
            <View style={styles.content}>
                <Text style={[styles.label, { color: theme.muted }]}>PROJECT</Text>
                <Text style={[styles.body, { color: theme.text }]}>
                    Project selection will be available here.
                </Text>
                <Text style={[styles.label, { color: theme.muted }]}>AGENT</Text>
                <Text style={[styles.body, { color: theme.text }]}>
                    Agent selection will be available here.
                </Text>
            </View>
        </SafeAreaView>
    );
}
