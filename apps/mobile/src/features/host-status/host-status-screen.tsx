/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MobileHostStatus } from '@caxri/protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { NoticeBanner } from '../../components/notice-banner';
import { ScreenHeader } from '../../components/screen-header';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
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
    onBack,
    onRetry,
    state,
    theme,
}: {
    onBack: () => void;
    onRetry: () => void;
    state: Exclude<HostStatusScreenState, { kind: 'ready' }>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.kind === 'loading')
        return (
            <ScreenState
                kind="loading"
                testID="host-status-loading"
                theme={theme}
                title={t('hostStatus.loading')}
            />
        );
    if (state.kind === 'offline')
        return (
            <ScreenState
                actionLabel={t('common.back')}
                kind="offline"
                onAction={onBack}
                testID="host-status-offline"
                theme={theme}
                title={t('hostStatus.offline')}
            />
        );
    return (
        <ScreenState
            actionLabel={t('common.retry')}
            kind="error"
            onAction={onRetry}
            testID="host-status-error"
            theme={theme}
            title={t('hostStatus.loadFailed')}
        />
    );
};

/**
 * The sections under a reading: Session load, Caxri's services, and the top processes.
 */
const HostStatusProcesses = ({
    onOpenSession,
    onSortChange,
    processes,
    sort,
    theme,
}: {
    onOpenSession: (sessionId: string) => void;
    onSortChange: (sort: ProcessSort) => void;
    processes: NonNullable<MobileHostStatus['processes']>;
    sort: ProcessSort;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const sessions = sessionRows(processes.sessions, t);
    const services = serviceRows(processes.services);
    const top = topProcessRows(processes.topProcesses, sort);
    return (
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
                            onOpen={onOpenSession}
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
                accessory={<ProcessSortToggle onChange={onSortChange} sort={sort} theme={theme} />}
                footer={t('hostStatus.processes.count', { count: processes.processCount })}
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
    );
};

/**
 * A reading on screen: the system card, then the process sections when `ps` answered.
 */
const HostStatusReady = ({
    onOpenSession,
    onSortChange,
    sort,
    status,
    theme,
}: {
    onOpenSession: (sessionId: string) => void;
    onSortChange: (sort: ProcessSort) => void;
    sort: ProcessSort;
    status: MobileHostStatus;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            <HostStatusSection
                testID="host-status-system"
                theme={theme}
                title={t('hostStatus.system.title')}
            >
                <HostSystemCard system={systemModel(status.system, t)} theme={theme} />
            </HostStatusSection>
            {status.processes ? (
                <HostStatusProcesses
                    onOpenSession={onOpenSession}
                    onSortChange={onSortChange}
                    processes={status.processes}
                    sort={sort}
                    theme={theme}
                />
            ) : (
                <Text
                    style={[styles.statusText, { color: theme.muted }]}
                    testID="host-status-processes-unavailable"
                >
                    {t('hostStatus.processesUnavailable')}
                </Text>
            )}
        </>
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
            <ScreenHeader
                leading="back"
                leadingLabel={t('hostStatus.back')}
                leadingTestID="host-status-back"
                onLeading={() => router.back()}
                subtitle={
                    data
                        ? t('hostStatus.updated', { time: formatSampledAt(data.sampledAt, locale) })
                        : undefined
                }
                subtitleTestID="host-status-updated"
                theme={theme}
                title={t('hostStatus.title')}
            />
            {banner ? (
                <NoticeBanner
                    message={banner.text}
                    testID="host-status-stale"
                    theme={theme}
                    tone={banner.isError ? 'danger' : 'muted'}
                />
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
                        onBack={() => router.back()}
                        onRetry={retry}
                        state={state.kind === 'ready' ? { kind: 'loading' } : state}
                        theme={theme}
                    />
                ) : (
                    <HostStatusReady
                        onOpenSession={openSession}
                        onSortChange={setSort}
                        sort={sort}
                        status={data}
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
        gap: mobileSpace.xl,
        maxWidth: 680,
        paddingBottom: mobileSpace.xxl,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.sm,
        width: '100%',
    },
    empty: { ...mobileType.body, padding: mobileSpace.lg, textAlign: 'center' },
    statusText: { ...mobileType.meta, padding: mobileSpace.md, textAlign: 'center' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
