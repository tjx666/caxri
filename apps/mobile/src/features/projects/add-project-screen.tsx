import { memo, useCallback } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MethodResult } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, Plus } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Chip } from '../../components/chip';
import { ScreenHeader } from '../../components/screen-header';
import { ScreenState } from '../../components/screen-state';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { queryScreenKind } from '../connection/query-screen-kind';
import { addProjectStyles as styles } from './add-project-styles';
import { canAddProjectBrowserEntry, canAddProjectBrowserLevel } from './project-browser-model';
import { useProjectBrowser } from './use-project-browser';

type BrowseEntry = MethodResult<'mobile.project.browse'>['entries'][number];

const FolderRow = memo(
    ({
        entry,
        isAdding,
        onAdd,
        onOpen,
        theme,
    }: {
        entry: BrowseEntry;
        isAdding: boolean;
        onAdd: (path: string) => Promise<void>;
        onOpen: (level: { name: string; path: string }) => void;
        theme: MobileTheme;
    }) => {
        const { t } = useTranslation();
        const Icon = entry.isGitRepository ? FolderGit2 : Folder;
        return (
            <View style={styles.row}>
                <Pressable
                    accessibilityHint={entry.hasChildren ? t('projects.openFolderHint') : undefined}
                    accessibilityLabel={
                        entry.isGitRepository
                            ? t('projects.gitRepositoryLabel', { name: entry.name })
                            : entry.name
                    }
                    accessibilityRole="button"
                    disabled={!entry.hasChildren}
                    onPress={() => onOpen({ name: entry.name, path: entry.relativePath })}
                    style={({ pressed }) => [
                        styles.rowMain,
                        { opacity: pressed ? PRESSED_OPACITY : 1 },
                    ]}
                    testID={`add-project-folder-${entry.relativePath}`}
                >
                    <Icon color={entry.isGitRepository ? theme.primary : theme.muted} size={20} />
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
                        {entry.name}
                    </Text>
                    {entry.hasChildren ? <ChevronRight color={theme.muted} size={18} /> : null}
                </Pressable>
                {canAddProjectBrowserEntry(entry) ? (
                    <Chip
                        accessibilityLabel={t('projects.addAsProject', { name: entry.name })}
                        icon={isAdding ? undefined : Plus}
                        label={t('projects.add')}
                        onPress={() => {
                            if (!isAdding) void onAdd(entry.relativePath);
                        }}
                        testID={`add-project-add-${entry.relativePath}`}
                        theme={theme}
                        tint={theme.primary}
                    >
                        {isAdding ? <Spinner color={theme.primary} /> : undefined}
                    </Chip>
                ) : null}
            </View>
        );
    },
);

const AddProjectState = ({
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
                testID="add-project-loading"
                theme={theme}
                title={t('projects.loading')}
            />
        );
    if (kind === 'offline')
        return (
            <ScreenState
                actionLabel={t('common.back')}
                kind="offline"
                onAction={onBack}
                testID="add-project-offline"
                theme={theme}
                title={t('projects.offline')}
            />
        );
    if (kind === 'error')
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={onRetry}
                testID="add-project-list-error"
                theme={theme}
                title={t('projects.listError')}
            />
        );
    return (
        <ScreenState
            kind="empty"
            testID="add-project-empty"
            theme={theme}
            title={t('projects.noFolders')}
        />
    );
};

const AddProjectFooter = ({
    browser,
    onAdd,
    theme,
}: {
    browser: ReturnType<typeof useProjectBrowser>;
    onAdd: (path: string) => Promise<void>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={[styles.footer, { borderColor: theme.border }]}>
            {browser.addError ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.error, { color: theme.danger }]}
                    testID="add-project-error"
                >
                    {browser.addError}
                </Text>
            ) : null}
            {canAddProjectBrowserLevel(browser.level) ? (
                <Button
                    isBusy={browser.addingPath !== null}
                    isDisabled={!browser.isConnected}
                    label={
                        browser.addingPath === browser.level.path
                            ? t('projects.adding')
                            : t('projects.addCurrent', { name: browser.level.name })
                    }
                    onPress={() => {
                        const { path } = browser.level;
                        if (path !== null) void onAdd(path);
                    }}
                    size="primary"
                    testID="add-project-add-current"
                    theme={theme}
                    variant="primary"
                />
            ) : (
                <Text style={[styles.hint, { color: theme.muted }]}>
                    {t('projects.footerHint')}
                </Text>
            )}
        </View>
    );
};

/**
 * Browses folders under the computer's home directory and adds one as a Project granted to this device. The Server owns
 * every path check; this screen only walks the listing it returns.
 */
export const AddProjectScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { t } = useTranslation();
    const browser = useProjectBrowser();
    const { add, addingPath, enter } = browser;
    const addAndClose = useCallback(
        async (path: string): Promise<void> => {
            if (await add(path)) router.back();
        },
        [add, router],
    );
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<BrowseEntry>) => (
            <FolderRow
                entry={item}
                isAdding={addingPath === item.relativePath}
                onAdd={addAndClose}
                onOpen={enter}
                theme={theme}
            />
        ),
        [addAndClose, addingPath, enter, theme],
    );
    const entries = browser.listing.data?.entries ?? [];
    const kind = queryScreenKind({
        fetchStatus: browser.listing.fetchStatus,
        hasData: browser.listing.data !== undefined,
        isError: browser.listing.isError,
        itemCount: entries.length,
    });
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="add-project-screen"
        >
            <ScreenHeader
                leading="back"
                leadingLabel={t('common.back')}
                leadingTestID="add-project-back"
                onLeading={() => router.back()}
                subtitle={
                    browser.level.path === null ? t('projects.home') : `~/${browser.level.path}`
                }
                theme={theme}
                title={t('projects.title')}
            />
            <FlatList
                contentContainerStyle={styles.listContent}
                data={entries}
                keyExtractor={(entry) => entry.relativePath}
                ListEmptyComponent={
                    <AddProjectState
                        kind={kind}
                        onBack={() => router.back()}
                        onRetry={() => {
                            void browser.listing.refetch();
                        }}
                        theme={theme}
                    />
                }
                ListFooterComponent={
                    browser.listing.data?.truncated ? (
                        <Text style={[styles.truncated, { color: theme.muted }]}>
                            {t('projects.truncated', { count: entries.length })}
                        </Text>
                    ) : undefined
                }
                ListHeaderComponent={
                    browser.canGoUp ? (
                        <Pressable
                            accessibilityRole="button"
                            onPress={browser.up}
                            style={({ pressed }) => [
                                styles.rowMain,
                                { opacity: pressed ? PRESSED_OPACITY : 1 },
                            ]}
                            testID="add-project-up"
                        >
                            <CornerLeftUp color={theme.muted} size={20} />
                            <Text style={[styles.rowTitle, { color: theme.text }]}>
                                {t('projects.upOneFolder')}
                            </Text>
                        </Pressable>
                    ) : undefined
                }
                renderItem={renderEntry}
                style={styles.list}
            />
            <AddProjectFooter browser={browser} onAdd={addAndClose} theme={theme} />
        </SafeAreaView>
    );
};
