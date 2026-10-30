/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MobileSessionSearchEntry, MobileSessionSearchStatus } from '@caxri/protocol';
import { snippetSegments } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ChevronLeft, Search, X } from 'lucide-react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { Chip } from '../../../components/chip';
import { IconButton } from '../../../components/icon-button';
import { NoticeBanner } from '../../../components/notice-banner';
import { ScreenState } from '../../../components/screen-state';
import { Spinner } from '../../../components/spinner';
import { useTranslation } from '../../../i18n';
import {
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { queryScreenKind } from '../../connection/query-screen-kind';
import { useSessionManagement } from '../hooks/use-session-management';
import { useSessionSearch } from '../hooks/use-session-search';
import { activeProjectFilter } from '../project-filter';
import { relativeAgeLabel, sessionTitleForDisplay } from '../session-row-model';
import type { SessionSearchRowAction } from '../session-search-model';
import {
    sessionSearchEmptyKey,
    sessionSearchIndexNotice,
    sessionSearchMatchLabel,
    sessionSearchRowAction,
} from '../session-search-model';
import { useHostSessions } from './host-sessions-provider';

const STATUS_FILTERS: ReadonlyArray<{
    labelKey: 'sessions.search.filterAll' | 'sessions.search.filterArchived';
    status: MobileSessionSearchStatus;
}> = [
    { labelKey: 'sessions.search.filterAll', status: 'caxri' },
    { labelKey: 'sessions.search.filterArchived', status: 'archived' },
];

const SearchSnippet = ({
    snippet,
    theme,
}: {
    snippet: NonNullable<MobileSessionSearchEntry['match']['snippet']>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const segments = snippetSegments(snippet);
    return (
        <Text numberOfLines={2} style={[styles.snippet, { color: theme.muted }]}>
            {snippet.role === 'user' ? t('sessions.search.speakerUser') : null}
            {segments.map((segment, index) => {
                if (!segment.isMatch) return segment.text;
                // A highlight's offset into the snippet is unique and stable, unlike its position among segments.
                const start = segments
                    .slice(0, index)
                    .reduce((length, previous) => length + previous.text.length, 0);
                return (
                    <Text key={start} style={[styles.match, { color: theme.text }]}>
                        {segment.text}
                    </Text>
                );
            })}
        </Text>
    );
};

const SearchRow = ({
    action,
    entry,
    isRestoring,
    now,
    onPress,
    projectTitle,
    theme,
}: {
    action: SessionSearchRowAction | undefined;
    entry: MobileSessionSearchEntry;
    isRestoring: boolean;
    now: number;
    onPress: (entry: MobileSessionSearchEntry, action: SessionSearchRowAction) => void;
    projectTitle: string | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const title = sessionTitleForDisplay(entry.title, t);
    const meta = [
        projectTitle,
        entry.status === 'archived' ? t('sessions.search.archived') : undefined,
        relativeAgeLabel(entry.updatedAt, now, t),
        sessionSearchMatchLabel(entry, t),
        entry.match.messageCount && entry.match.messageCount > 1
            ? t('sessions.search.messageCount', { count: entry.match.messageCount })
            : undefined,
    ]
        .filter(Boolean)
        .join(' · ');
    return (
        <Pressable
            accessibilityHint={t(
                action === 'restore'
                    ? 'sessions.search.restoreHint'
                    : action === 'open'
                      ? 'sessions.row.openHint'
                      : 'sessions.search.viewOnlyArchived',
            )}
            accessibilityLabel={title}
            accessibilityRole="button"
            accessibilityState={{ busy: isRestoring, disabled: action === undefined }}
            disabled={action === undefined || isRestoring}
            onPress={() => {
                if (action) onPress(entry, action);
            }}
            style={({ pressed }) => [styles.row, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
            testID={`session-search-result-${entry.sessionId}`}
        >
            <AgentAvatar kind={entry.provider} theme={theme} />
            <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                    {title}
                </Text>
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {meta}
                </Text>
                {entry.match.snippet ? (
                    <SearchSnippet snippet={entry.match.snippet} theme={theme} />
                ) : null}
            </View>
            {isRestoring ? <Spinner color={theme.primary} /> : null}
        </Pressable>
    );
};

/**
 * Searches the titles, folders, IDs, and messages of this device's open and archived Sessions, through the same index
 * as Desktop's Session search. An empty query lists the most recent Sessions.
 */
export const SessionSearchScreen = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const theme = useMobileTheme();
    const { hostId, sessions, ui } = useHostSessions();
    const search = useSessionSearch(activeProjectFilter(ui.projectId, sessions.projects));
    const { response } = search;
    const management = useSessionManagement();
    /**
     * Result ages are coarse (minutes and up), so the time captured when the screen opens is precise enough.
     */
    const [now] = useState(Date.now);
    const projectTitles = new Map(sessions.projects.map(({ id, title }) => [id, title]));
    const openEntry = useCallback(
        (entry: MobileSessionSearchEntry, action: SessionSearchRowAction): void => {
            const href =
                `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(entry.sessionId)}` as const;
            if (action === 'open') router.navigate(href);
            else
                void management.restore(entry.sessionId).then((done) => {
                    if (done) router.navigate(href);
                });
        },
        [hostId, management, router],
    );
    const renderItem = ({ item }: ListRenderItemInfo<MobileSessionSearchEntry>) => (
        <SearchRow
            action={sessionSearchRowAction(item, sessions.deviceRole)}
            entry={item}
            isRestoring={management.pending?.sessionId === item.sessionId}
            now={now}
            onPress={openEntry}
            projectTitle={projectTitles.get(item.projectId)}
            theme={theme}
        />
    );
    const entries = response.data?.entries ?? [];
    const kind = queryScreenKind({
        fetchStatus: response.fetchStatus,
        hasData: response.data !== undefined,
        isError: response.isError,
        itemCount: entries.length,
    });
    const notice = sessionSearchIndexNotice(response.data, t);
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="session-search-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel={t('sessions.search.back')}
                    icon={ChevronLeft}
                    onPress={() => router.back()}
                    size={24}
                    testID="session-search-back"
                    theme={theme}
                />
                <View style={[styles.field, { backgroundColor: theme.surface }]}>
                    <Search color={theme.muted} size={18} />
                    <TextInput
                        accessibilityLabel={t('sessions.search.open')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus
                        onChangeText={search.setQuery}
                        placeholder={t('sessions.search.placeholder')}
                        placeholderTextColor={theme.muted}
                        returnKeyType="search"
                        style={[styles.input, { color: theme.text }]}
                        testID="session-search-input"
                        value={search.query}
                    />
                    {response.isFetching && response.data !== undefined ? (
                        <Spinner color={theme.muted} />
                    ) : null}
                    {search.query ? (
                        <IconButton
                            accessibilityLabel={t('sessions.search.clear')}
                            icon={X}
                            onPress={() => search.setQuery('')}
                            size={18}
                            testID="session-search-clear"
                            theme={theme}
                        />
                    ) : null}
                </View>
            </View>
            <View style={styles.filters}>
                {STATUS_FILTERS.map(({ labelKey, status }) => (
                    <Chip
                        key={status}
                        label={t(labelKey)}
                        onPress={() => search.setStatus(status)}
                        selected={search.status === status}
                        testID={`session-search-filter-${status}`}
                        theme={theme}
                    />
                ))}
            </View>
            {notice ? (
                <Text style={[styles.notice, { color: theme.muted }]} testID="session-search-index">
                    {notice}
                </Text>
            ) : null}
            {management.error ? (
                <NoticeBanner
                    message={management.error}
                    testID="session-search-restore-error"
                    theme={theme}
                    tone="danger"
                />
            ) : null}
            <FlatList
                contentContainerStyle={styles.listContent}
                data={entries}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                keyExtractor={(item) => item.sessionId}
                ListEmptyComponent={
                    kind === 'loading' ? (
                        <ScreenState
                            kind="loading"
                            testID="session-search-loading"
                            theme={theme}
                            title={t('sessions.search.searching')}
                        />
                    ) : kind === 'offline' ? (
                        <ScreenState
                            actionLabel={t('common.back')}
                            kind="offline"
                            onAction={() => router.back()}
                            testID="session-search-offline"
                            theme={theme}
                            title={t('sessions.search.offline')}
                        />
                    ) : kind === 'error' ? (
                        <ScreenState
                            actionLabel={t('common.retry')}
                            kind="error"
                            onAction={() => {
                                void response.refetch();
                            }}
                            testID="session-search-error"
                            theme={theme}
                            title={t('sessions.search.failed')}
                        />
                    ) : (
                        <ScreenState
                            kind="empty"
                            testID="session-search-empty"
                            theme={theme}
                            title={t(sessionSearchEmptyKey(search.searchedQuery, response.data))}
                        />
                    )
                }
                renderItem={renderItem}
                style={styles.list}
                testID="session-search-results"
            />
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        paddingLeft: mobileSpace.xs,
        paddingRight: mobileSpace.lg,
        paddingVertical: mobileSpace.xs,
    },
    field: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingLeft: mobileSpace.md,
    },
    input: { ...mobileType.body, flex: 1, paddingVertical: mobileSpace.sm },
    filters: {
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.xs,
    },
    notice: {
        ...mobileType.meta,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
    },
    list: { flex: 1 },
    listContent: {
        alignSelf: 'center',
        flexGrow: 1,
        maxWidth: 680,
        paddingHorizontal: mobileSpace.sm,
        width: '100%',
    },
    row: {
        alignItems: 'flex-start',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: 64,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
    },
    copy: { flex: 1, gap: mobileSpace.xxs, minWidth: 0 },
    title: { ...mobileType.bodyStrong, fontWeight: '500' },
    meta: mobileType.meta,
    snippet: mobileType.meta,
    match: { fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
