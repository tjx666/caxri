import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { allMobileSessions } from '../hooks/use-session-polling';
import { describeSessionHomeEmptyState } from '../session-home-empty-state';
import type { MobileSessionSections } from '../session-model';
import { isSessionListErrorShown } from '../session-notices';
import { savedAgeLabel } from '../session-row-model';

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
    empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 28 },
    emptyTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
    emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
    limit: { borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 8 },
    limitText: { fontSize: 12, fontVariant: ['tabular-nums'], lineHeight: 16 },
    retry: { justifyContent: 'center', minHeight: 48, paddingHorizontal: 8 },
    retryText: { fontSize: 14, fontWeight: '700' },
});

export const SessionHomeStatus = ({
    error,
    hasLoaded,
    isConnectionNoticeShown,
    isLoading,
    now,
    onRetry,
    savedAt,
    sections,
    theme,
}: {
    error: string | null;
    hasLoaded: boolean;
    /**
     * Whether the app-wide connection banner above already explains why the list is not live.
     */
    isConnectionNoticeShown: boolean;
    isLoading: boolean;
    now: number;
    onRetry: () => Promise<void>;
    /**
     * Set while the list is the copy saved on this phone rather than a live read.
     */
    savedAt: number | null;
    sections: MobileSessionSections;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {savedAt === null ? null : (
                <View
                    style={[styles.limit, { borderColor: theme.border }]}
                    testID="session-list-saved"
                >
                    <Text style={[styles.limitText, { color: theme.muted }]}>
                        {t('sessions.home.savedCopy', { saved: savedAgeLabel(savedAt, now, t) })}
                    </Text>
                </View>
            )}
            {isSessionListErrorShown({ error, hasLoaded, isConnectionNoticeShown }) ? (
                <View
                    style={[
                        styles.banner,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    <Text
                        accessibilityRole="alert"
                        style={[styles.bannerText, { color: theme.text }]}
                    >
                        {t('sessions.home.listError', { error: error ?? '' })}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isLoading }}
                        disabled={isLoading}
                        onPress={onRetry}
                        style={styles.retry}
                        testID="session-list-retry"
                    >
                        <Text style={[styles.retryText, { color: theme.primary }]}>
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
            {sections.truncated ? (
                <View style={[styles.limit, { borderColor: theme.border }]}>
                    <Text style={[styles.limitText, { color: theme.muted }]}>
                        {t('sessions.home.truncated', {
                            shown: allMobileSessions(sections).length,
                            total: sections.total,
                        })}
                    </Text>
                </View>
            ) : null}
        </>
    );
};

export const SessionHomeEmpty = ({
    activeProjectId,
    error,
    hasLoaded,
    isLoading,
    onNewSession,
    onRetry,
    status,
    theme,
}: {
    activeProjectId: string | null;
    error: string | null;
    hasLoaded: boolean;
    isLoading: boolean;
    onNewSession: () => void;
    onRetry: () => Promise<void>;
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const state = describeSessionHomeEmptyState({ activeProjectId, error, hasLoaded, status }, t);
    const action = state.action === 'new' ? onNewSession : onRetry;
    return (
        <View style={styles.empty} testID={state.testID}>
            {state.title ? (
                <Text
                    accessibilityRole={state.titleRole}
                    style={[styles.emptyTitle, { color: theme.text }]}
                >
                    {state.title}
                </Text>
            ) : null}
            {state.showSpinner ? <ActivityIndicator color={theme.primary} size="small" /> : null}
            <Text style={[styles.emptyBody, { color: theme.muted }]}>{state.body}</Text>
            {state.action ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={
                        state.action === 'retry' ? { disabled: isLoading } : undefined
                    }
                    disabled={state.action === 'retry' && isLoading}
                    onPress={action}
                    style={styles.retry}
                    testID={
                        state.action === 'retry'
                            ? 'session-list-initial-retry'
                            : 'session-list-empty-new'
                    }
                >
                    <Text style={[styles.retryText, { color: theme.primary }]}>
                        {t(state.action === 'retry' ? 'common.retry' : 'sessions.new.title')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};
