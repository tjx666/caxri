/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { AgentUsageCard } from './agent-usage-card';
import { agentUsageCards } from './agent-usage-model';
import { useAgentUsage } from './use-agent-usage';

/**
 * Each Agent's plan limits, output speed, and provider API status in one place, so a glance from the phone answers "how
 * much is left, when does it reset, and is the provider having trouble" without the Desktop status bar.
 */
export const AgentUsageScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { locale, t } = useTranslation();
    const query = useAgentUsage();
    // Countdowns are relative to the render; the 30-second poll re-renders often enough for minutes.
    // eslint-disable-next-line react-hooks/purity -- a countdown is relative to the render time by definition
    const now = Date.now();
    const cards = query.data ? agentUsageCards(query.data.providers, now, locale, t) : undefined;
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="agent-usage-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel={t('usage.back')}
                    icon={ChevronLeft}
                    onPress={() => router.back()}
                    size={24}
                    testID="agent-usage-back"
                    theme={theme}
                />
                <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
                    {t('usage.title')}
                </Text>
            </View>
            <ScrollView
                contentContainerStyle={styles.content}
                refreshControl={
                    <RefreshControl
                        colors={[theme.primary]}
                        onRefresh={() => {
                            void query.refetch();
                        }}
                        progressBackgroundColor={theme.surface}
                        refreshing={query.isRefetching}
                        tintColor={theme.primary}
                    />
                }
            >
                {cards ? (
                    cards.map((card) => (
                        <AgentUsageCard card={card} key={card.provider} theme={theme} />
                    ))
                ) : query.isError ? (
                    <View style={styles.status} testID="agent-usage-error">
                        <Text
                            accessibilityRole="alert"
                            style={[styles.statusText, { color: theme.danger }]}
                        >
                            {t('usage.loadFailed')}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => {
                                void query.refetch();
                            }}
                            style={({ pressed }) => [
                                styles.retry,
                                { backgroundColor: pressed ? theme.elevated : theme.surface },
                            ]}
                            testID="agent-usage-retry"
                        >
                            <Text style={[styles.retryText, { color: theme.text }]}>
                                {t('usage.retry')}
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <View style={styles.status} testID="agent-usage-loading">
                        <Spinner color={theme.primary} />
                        <Text style={[styles.statusText, { color: theme.muted }]}>
                            {t('usage.loading')}
                        </Text>
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingHorizontal: 6 },
    heading: { fontSize: 20, fontWeight: '700', marginLeft: 6 },
    content: {
        alignSelf: 'center',
        gap: 16,
        maxWidth: 680,
        paddingBottom: 32,
        paddingHorizontal: 16,
        paddingTop: 8,
        width: '100%',
    },
    status: { alignItems: 'center', gap: 12, paddingTop: 48 },
    statusText: { fontSize: 14, textAlign: 'center' },
    retry: {
        alignItems: 'center',
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 44,
        paddingHorizontal: 18,
    },
    retryText: { fontSize: 15, fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
