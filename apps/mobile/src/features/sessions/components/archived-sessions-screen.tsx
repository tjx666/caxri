/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MethodResult } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ArchiveRestore } from 'lucide-react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { Chip } from '../../../components/chip';
import { NoticeBanner } from '../../../components/notice-banner';
import { ScreenHeader } from '../../../components/screen-header';
import { ScreenState } from '../../../components/screen-state';
import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { queryScreenKind } from '../../connection/query-screen-kind';
import { useArchivedSessions } from '../hooks/use-archived-sessions';
import { useSessionManagement } from '../hooks/use-session-management';
import { archivedAgeLabel, sessionTitleForDisplay } from '../session-row-model';
import { useHostSessions } from './host-sessions-provider';

type ArchivedSession = MethodResult<'mobile.session.archived'>['sessions'][number];

const ArchivedRow = ({
    canRestore,
    isRestoring,
    now,
    onRestore,
    session,
    theme,
}: {
    canRestore: boolean;
    isRestoring: boolean;
    now: number;
    onRestore: (sessionId: string) => void;
    session: ArchivedSession;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.row} testID={`archived-session-${session.id}`}>
            <AgentAvatar kind={session.agentKind} theme={theme} />
            <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                    {sessionTitleForDisplay(session.title, t)}
                </Text>
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {`${session.projectTitle} · ${archivedAgeLabel(session.archivedAt, now, t)}`}
                </Text>
            </View>
            {canRestore ? (
                <Chip
                    accessibilityLabel={t('sessions.archived.restoreLabel', {
                        title: sessionTitleForDisplay(session.title, t),
                    })}
                    icon={isRestoring ? undefined : ArchiveRestore}
                    label={t('sessions.archived.restore')}
                    onPress={() => {
                        if (!isRestoring) onRestore(session.id);
                    }}
                    testID={`archived-session-restore-${session.id}`}
                    theme={theme}
                    tint={theme.primary}
                >
                    {isRestoring ? <Spinner color={theme.primary} /> : undefined}
                </Chip>
            ) : null}
        </View>
    );
};

const ArchivedState = ({
    kind,
    onBack,
    onRetry,
    theme,
}: {
    kind: ReturnType<typeof queryScreenKind>;
    onBack: () => void;
    onRetry: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (kind === 'loading')
        return (
            <ScreenState
                kind="loading"
                testID="archived-sessions-loading"
                theme={theme}
                title={t('sessions.archived.loading')}
            />
        );
    if (kind === 'offline')
        return (
            <ScreenState
                actionLabel={t('common.back')}
                kind="offline"
                onAction={onBack}
                testID="archived-sessions-offline"
                theme={theme}
                title={t('sessions.archived.offline')}
            />
        );
    if (kind === 'error')
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={onRetry}
                testID="archived-sessions-load-error"
                theme={theme}
                title={t('sessions.archived.loadFailed')}
            />
        );
    return (
        <ScreenState
            kind="empty"
            testID="archived-sessions-empty"
            theme={theme}
            title={t('sessions.archived.empty')}
        />
    );
};

/**
 * Lists this device's archived Sessions, newest first. Restoring needs Control access; View and Reply devices can still
 * browse the list.
 */
export const ArchivedSessionsScreen = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const theme = useMobileTheme();
    const { sessions } = useHostSessions();
    const archived = useArchivedSessions();
    const management = useSessionManagement();
    const canRestore = sessions.deviceRole === 'control';
    const { refetch } = archived;
    const restore = useCallback(
        (sessionId: string): void => {
            void management.restore(sessionId).then((done) => (done ? refetch() : undefined));
        },
        [management, refetch],
    );
    /**
     * Archive ages are coarse (minutes and up), so the time captured when the screen opens is precise enough.
     */
    const [now] = useState(Date.now);
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<ArchivedSession>) => (
            <ArchivedRow
                canRestore={canRestore}
                isRestoring={management.pending?.sessionId === item.id}
                now={now}
                onRestore={restore}
                session={item}
                theme={theme}
            />
        ),
        [canRestore, management.pending, now, restore, theme],
    );
    const list = archived.data?.sessions ?? [];
    const kind = queryScreenKind({
        fetchStatus: archived.fetchStatus,
        hasData: archived.data !== undefined,
        isError: archived.isError,
        itemCount: list.length,
    });
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="archived-sessions-screen"
        >
            <ScreenHeader
                leading="back"
                leadingLabel={t('sessions.archived.back')}
                leadingTestID="archived-sessions-back"
                onLeading={() => router.back()}
                theme={theme}
                title={t('sessions.home.archivedSessions')}
            />
            {management.error ? (
                <NoticeBanner
                    message={management.error}
                    testID="archived-sessions-error"
                    theme={theme}
                    tone="danger"
                />
            ) : null}
            <FlatList
                contentContainerStyle={styles.listContent}
                data={list}
                keyExtractor={(item) => item.id}
                ListEmptyComponent={
                    <ArchivedState
                        kind={kind}
                        onBack={() => router.back()}
                        onRetry={() => {
                            void refetch();
                        }}
                        theme={theme}
                    />
                }
                ListFooterComponent={
                    archived.data?.truncated ? (
                        <Text style={[styles.footer, { color: theme.muted }]}>
                            {t('sessions.archived.truncated', {
                                shown: list.length,
                                total: archived.data.total,
                            })}
                        </Text>
                    ) : undefined
                }
                onRefresh={() => {
                    void refetch();
                }}
                refreshing={archived.isRefetching}
                renderItem={renderItem}
                style={styles.list}
                testID="archived-sessions-list"
            />
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    list: { flex: 1 },
    listContent: {
        alignSelf: 'center',
        flexGrow: 1,
        maxWidth: 680,
        paddingHorizontal: mobileSpace.sm,
        width: '100%',
    },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: 64,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
    },
    copy: { flex: 1, gap: mobileSpace.xxs, minWidth: 0 },
    title: { ...mobileType.bodyStrong, fontWeight: '500' },
    meta: mobileType.meta,
    footer: { ...mobileType.meta, padding: mobileSpace.md, textAlign: 'center' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
