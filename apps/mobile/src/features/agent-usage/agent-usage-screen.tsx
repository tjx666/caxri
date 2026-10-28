/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { NoticeBanner } from '../../components/notice-banner';
import { ScreenHeader } from '../../components/screen-header';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { AgentUsageCard } from './agent-usage-card';
import type { AgentUsageScreenState } from './agent-usage-model';
import { agentUsageCards, agentUsageScreenState } from './agent-usage-model';
import { useAgentUsage } from './use-agent-usage';

const AgentUsageStatus = ({
    onBack,
    onRetry,
    state,
    theme,
}: {
    onBack: () => void;
    onRetry: () => void;
    state: Exclude<AgentUsageScreenState, { kind: 'ready' }>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.kind === 'loading')
        return (
            <ScreenState
                kind="loading"
                testID="agent-usage-loading"
                theme={theme}
                title={t('usage.loading')}
            />
        );
    if (state.kind === 'offline')
        return (
            <ScreenState
                actionLabel={t('common.back')}
                kind="offline"
                onAction={onBack}
                testID="agent-usage-offline"
                theme={theme}
                title={t('usage.offline')}
            />
        );
    return (
        <ScreenState
            actionLabel={t('usage.retry')}
            kind="error"
            onAction={onRetry}
            testID="agent-usage-error"
            theme={theme}
            title={t('usage.loadFailed')}
        />
    );
};

/**
 * Each Agent's plan limits, output speed, and provider API status in one place, so a glance from the phone answers "how
 * much is left, when does it reset, and is the provider having trouble" without the Desktop status bar.
 */
export const AgentUsageScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { locale, t } = useTranslation();
    const { isObservable, query } = useAgentUsage();
    const state = agentUsageScreenState({
        hasData: query.data !== undefined,
        isError: query.isError,
        isObservable,
    });
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
            <ScreenHeader
                leading="back"
                leadingLabel={t('usage.back')}
                leadingTestID="agent-usage-back"
                onLeading={() => router.back()}
                theme={theme}
                title={t('usage.title')}
            />
            {state.kind === 'ready' && state.isStale ? (
                <NoticeBanner
                    message={t('usage.staleNotice')}
                    testID="agent-usage-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
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
                ) : state.kind === 'ready' ? null : (
                    <AgentUsageStatus
                        onBack={() => router.back()}
                        onRetry={() => {
                            void query.refetch();
                        }}
                        state={state}
                        theme={theme}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    content: {
        alignSelf: 'center',
        flexGrow: 1,
        gap: mobileSpace.lg,
        maxWidth: 680,
        paddingBottom: mobileSpace.xxl,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.sm,
        width: '100%',
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
