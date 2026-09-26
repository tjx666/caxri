/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MethodResult } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ArchiveRestore, ChevronLeft } from 'lucide-react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useArchivedSessions } from '../hooks/use-archived-sessions';
import { useSessionManagement } from '../hooks/use-session-management';
import { archivedAgeLabel } from '../session-row-model';
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
}) => (
    <View style={styles.row} testID={`archived-session-${session.id}`}>
        <AgentAvatar kind={session.agentKind} theme={theme} />
        <View style={styles.copy}>
            <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                {session.displayTitle}
            </Text>
            <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                {`${session.projectTitle} · ${archivedAgeLabel(session.archivedAt, now)}`}
            </Text>
        </View>
        {canRestore ? (
            <Pressable
                accessibilityLabel={`Restore ${session.displayTitle}`}
                accessibilityRole="button"
                accessibilityState={{ busy: isRestoring, disabled: isRestoring }}
                disabled={isRestoring}
                onPress={() => onRestore(session.id)}
                style={({ pressed }) => [
                    styles.restore,
                    { borderColor: theme.primary, opacity: pressed ? 0.6 : 1 },
                ]}
                testID={`archived-session-restore-${session.id}`}
            >
                {isRestoring ? (
                    <ActivityIndicator color={theme.primary} size="small" />
                ) : (
                    <ArchiveRestore color={theme.primary} size={16} />
                )}
                <Text style={[styles.restoreText, { color: theme.primary }]}>Restore</Text>
            </Pressable>
        ) : null}
    </View>
);

/**
 * Lists this device's archived Sessions, newest first. Restoring needs Control access; View and Reply devices can still
 * browse the list.
 */
export const ArchivedSessionsScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { sessions } = useHostSessions();
    const archived = useArchivedSessions();
    const management = useSessionManagement();
    const canRestore = sessions.deviceRole === 'control';
    const { refetch } = archived;
    const restore = useCallback(
        (sessionId: string): void => {
            // eslint-disable-next-line no-void -- The hook renders restore failures.
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
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="archived-sessions-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel="Back"
                    icon={ChevronLeft}
                    onPress={() => router.back()}
                    size={24}
                    testID="archived-sessions-back"
                    theme={theme}
                />
                <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
                    Archived Sessions
                </Text>
            </View>
            {management.error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.error, { color: theme.danger }]}
                    testID="archived-sessions-error"
                >
                    {management.error}
                </Text>
            ) : null}
            <FlatList
                contentContainerStyle={styles.listContent}
                data={list}
                keyExtractor={(item) => item.id}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {archived.isPending ? (
                            <ActivityIndicator color={theme.muted} />
                        ) : (
                            <Text style={[styles.emptyText, { color: theme.muted }]}>
                                {archived.isError
                                    ? 'Unable to load archived Sessions.'
                                    : 'No archived Sessions.'}
                            </Text>
                        )}
                    </View>
                }
                ListFooterComponent={
                    archived.data?.truncated ? (
                        <Text style={[styles.emptyText, { color: theme.muted }]}>
                            Showing the {list.length} most recent of {archived.data.total}.
                        </Text>
                    ) : null
                }
                onRefresh={() => {
                    // eslint-disable-next-line no-void -- The query renders refresh failures.
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
    header: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingHorizontal: 6 },
    heading: { fontSize: 20, fontWeight: '700', marginLeft: 6 },
    list: { flex: 1 },
    listContent: { alignSelf: 'center', maxWidth: 680, paddingHorizontal: 8, width: '100%' },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 64,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    copy: { flex: 1, gap: 3, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '500' },
    meta: { fontSize: 13 },
    restore: {
        alignItems: 'center',
        borderRadius: 16,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 6,
        minHeight: 34,
        paddingHorizontal: 12,
    },
    restoreText: { fontSize: 13, fontWeight: '700' },
    empty: { alignItems: 'center', padding: 32 },
    emptyText: { fontSize: 13, padding: 12, textAlign: 'center' },
    error: { fontSize: 13, paddingBottom: 8, paddingHorizontal: 20 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
