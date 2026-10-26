/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import type { HostStatusScreenState, ProcessSort } from './host-status-model';
import {
    formatSampledAt,
    hostStatusScreenState,
    serviceRows,
    sessionRows,
    systemModel,
    topProcessRows,
} from './host-status-model';
import {
    HostProcessRow,
    HostSessionRow,
    HostStatusSection,
    HostSystemCard,
    ProcessSortToggle,
} from './host-status-sections';
import { useHostStatus } from './use-host-status';

const StatusMessage = ({
    onRetry,
    state,
    theme,
}: {
    onRetry: () => void;
    state: Exclude<HostStatusScreenState, { kind: 'ready' }>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.kind === 'loading')
        return (
            <View style={styles.status} testID="host-status-loading">
                <Spinner color={theme.primary} />
            </View>
        );
    const isError = state.kind === 'error';
    return (
        <View style={styles.status} testID={`host-status-${state.kind}`}>
            <Text
                accessibilityRole={isError ? 'alert' : undefined}
                style={[styles.statusText, { color: isError ? theme.danger : theme.muted }]}
            >
                {t(isError ? 'hostStatus.loadFailed' : 'hostStatus.offline')}
            </Text>
            {isError ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={[styles.retry, { borderColor: theme.border }]}
                    testID="host-status-retry"
                >
                    <Text style={[styles.retryText, { color: theme.primary }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * The paired computer at a glance: system CPU and memory, each Session's load from its running Terminals, Caxri's own
 * services, and the busiest processes. The phone counterpart of Desktop's Process Explorer, read-only.
 */
export const HostStatusScreen = () => {
    const { locale, t } = useTranslation();
    const router = useRouter();
    const theme = useMobileTheme();
    const { 'host-id': hostId } = useLocalSearchParams<{ 'host-id': string }>();
    const { isObservable, query, refresh } = useHostStatus();
    const [sort, setSort] = useState<ProcessSort>('cpu');
    /**
     * Only a pull shows the spinner; the background poll every two seconds would otherwise flash it constantly.
     */
    const [isPulling, setPulling] = useState(false);
    const pull = useCallback(() => {
        setPulling(true);
        void refresh().finally(() => setPulling(false));
    }, [refresh]);
    const retry = useCallback(() => {
        void refresh();
    }, [refresh]);
    const { data } = query;
    const state = hostStatusScreenState({
        hasData: data !== undefined,
        isError: query.isError,
        isObservable,
    });
    const openSession = useCallback(
        (sessionId: string) =>
            router.navigate(`/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}`),
        [hostId, router],
    );
    const processes = data?.processes;
    const sessions = processes ? sessionRows(processes.sessions, t) : [];
    const services = processes ? serviceRows(processes.services) : [];
    const top = processes ? topProcessRows(processes.topProcesses, sort) : [];
    const banner =
        state.kind === 'ready' && (state.isStale || state.hasRefreshError)
            ? {
                  isError: state.hasRefreshError,
                  text: t(state.isStale ? 'hostStatus.staleNotice' : 'hostStatus.refreshFailed'),
              }
            : null;
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="host-status-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel={t('hostStatus.back')}
                    icon={ChevronLeft}
                    onPress={() => router.back()}
                    size={24}
                    testID="host-status-back"
                    theme={theme}
                />
                <View style={styles.headingBlock}>
                    <Text
                        accessibilityRole="header"
                        style={[styles.heading, { color: theme.text }]}
                    >
                        {t('hostStatus.title')}
                    </Text>
                    {data ? (
                        <Text
                            style={[styles.updated, { color: theme.muted }]}
                            testID="host-status-updated"
                        >
                            {t('hostStatus.updated', {
                                time: formatSampledAt(data.sampledAt, locale),
                            })}
                        </Text>
                    ) : null}
                </View>
            </View>
            {banner ? (
                <Text
                    accessibilityRole={banner.isError ? 'alert' : undefined}
                    style={[
                        styles.banner,
                        {
                            borderColor: theme.border,
                            color: banner.isError ? theme.danger : theme.muted,
                        },
                    ]}
                    testID="host-status-stale"
                >
                    {banner.text}
                </Text>
            ) : null}
            <ScrollView
                contentContainerStyle={styles.content}
                refreshControl={
                    <RefreshControl
                        onRefresh={pull}
                        refreshing={isPulling}
                        tintColor={theme.muted}
                    />
                }
                testID="host-status-scroll"
            >
                {!data || state.kind !== 'ready' ? (
                    <StatusMessage
                        onRetry={retry}
                        state={state.kind === 'ready' ? { kind: 'loading' } : state}
                        theme={theme}
                    />
                ) : (
                    <>
                        <HostStatusSection
                            testID="host-status-system"
                            theme={theme}
                            title={t('hostStatus.system.title')}
                        >
                            <HostSystemCard system={systemModel(data.system, t)} theme={theme} />
                        </HostStatusSection>
                        {processes ? (
                            <>
                                <HostStatusSection
                                    footer={
                                        processes.sessionTotal > sessions.length
                                            ? t('hostStatus.sessions.truncated', {
                                                  shown: sessions.length,
                                                  total: processes.sessionTotal,
                                              })
                                            : undefined
                                    }
                                    testID="host-status-sessions"
                                    theme={theme}
                                    title={t('hostStatus.sessions.title')}
                                >
                                    {sessions.length === 0 ? (
                                        <Text style={[styles.empty, { color: theme.muted }]}>
                                            {t('hostStatus.sessions.empty')}
                                        </Text>
                                    ) : (
                                        sessions.map((row, index) => (
                                            <HostSessionRow
                                                isLast={index === sessions.length - 1}
                                                key={row.id}
                                                onOpen={openSession}
                                                row={row}
                                                theme={theme}
                                            />
                                        ))
                                    )}
                                </HostStatusSection>
                                {services.length > 0 ? (
                                    <HostStatusSection
                                        testID="host-status-services"
                                        theme={theme}
                                        title={t('hostStatus.services.title')}
                                    >
                                        {services.map((row, index) => (
                                            <HostProcessRow
                                                isLast={index === services.length - 1}
                                                key={row.id}
                                                row={row}
                                                testID={`host-status-service-${row.id}`}
                                                theme={theme}
                                            />
                                        ))}
                                    </HostStatusSection>
                                ) : null}
                                <HostStatusSection
                                    accessory={
                                        <ProcessSortToggle
                                            onChange={setSort}
                                            sort={sort}
                                            theme={theme}
                                        />
                                    }
                                    footer={t('hostStatus.processes.count', {
                                        count: processes.processCount,
                                    })}
                                    testID="host-status-processes"
                                    theme={theme}
                                    title={t('hostStatus.processes.title')}
                                >
                                    {top.map((row, index) => (
                                        <HostProcessRow
                                            isLast={index === top.length - 1}
                                            key={row.id}
                                            row={row}
                                            testID={`host-status-process-${row.id}`}
                                            theme={theme}
                                        />
                                    ))}
                                </HostStatusSection>
                            </>
                        ) : (
                            <Text
                                style={[styles.statusText, { color: theme.muted }]}
                                testID="host-status-processes-unavailable"
                            >
                                {t('hostStatus.processesUnavailable')}
                            </Text>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingHorizontal: 6 },
    headingBlock: { flex: 1, marginLeft: 6 },
    heading: { fontSize: 20, fontWeight: '700' },
    updated: { fontSize: 12, fontVariant: ['tabular-nums'] },
    banner: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        fontSize: 13,
        paddingBottom: 8,
        paddingHorizontal: 20,
    },
    content: {
        alignSelf: 'center',
        gap: 22,
        maxWidth: 680,
        paddingBottom: 32,
        paddingHorizontal: 16,
        paddingTop: 8,
        width: '100%',
    },
    empty: { fontSize: 14, padding: 16, textAlign: 'center' },
    status: { alignItems: 'center', gap: 12, padding: 32 },
    statusText: { fontSize: 14, padding: 12, textAlign: 'center' },
    retry: {
        alignItems: 'center',
        borderRadius: 18,
        borderWidth: 1,
        justifyContent: 'center',
        minHeight: 36,
        paddingHorizontal: 16,
    },
    retryText: { fontSize: 14, fontWeight: '700' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
