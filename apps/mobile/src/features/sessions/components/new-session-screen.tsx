import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';
import { X } from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
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
                <IconButton
                    accessibilityLabel="Back to Sessions"
                    icon={X}
                    onPress={() => router.back()}
                    size={24}
                    testID="new-session-back"
                    theme={theme}
                />
                <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                    New Session
                </Text>
            </View>
            <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
                <NewSessionStatus state={state} theme={theme} />
                <NewSessionSelections
                    onAddProject={
                        state.deviceRole === 'control'
                            ? () =>
                                  router.navigate(
                                      `/h/${encodeURIComponent(state.hostId)}/add-project`,
                                  )
                            : undefined
                    }
                    state={state}
                    theme={theme}
                />
            </ScrollView>
            <NewSessionFooter state={state} theme={theme} />
        </SafeAreaView>
    );
};
